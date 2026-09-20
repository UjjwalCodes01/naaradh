import { describe, expect, it } from 'vitest';
import { baseRequest, driver, runContractSuite } from '@naaradh/engine-harness';
import { EngineUnavailable } from '@naaradh/engines-core';
import { SignatureInvalidError, isNaaradhError } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { BolnaAdapter, INBOUND_GREETING_VAR, INBOUND_PROMPT_VAR } from '../src/index.js';
import { fakeBolna } from './fake-bolna.js';

/**
 * P1-ENG-3 — the Bolna adapter against the shared engine contract (AGENTS §10), driven by a
 * stand-in for Bolna's API (./fake-bolna.ts, shaped from the published reference until real
 * payloads are recorded). Bolna signs nothing, so the bad-signature scenario is replaced by the
 * one that matters for it: the fetched record carries the outcome. Transfer scenarios are
 * skipped (no warm transfer), the disclosure event too (it cannot report one).
 */

const KEY = 'bn-test-0123456789abcdef0123456789abcdef';
const TOOL_TOKEN = 't'.repeat(40);
const NOW = new Date('2026-09-14T10:31:30Z');
const now = () => NOW;

const make = (extra: { inboundEnabled?: boolean; toolToken?: string | undefined } = {}) => {
  const fake = fakeBolna();
  const adapter = new BolnaAdapter({
    apiKey: KEY,
    baseUrl: 'https://api.bolna.test',
    toolToken: 'toolToken' in extra ? extra.toolToken : TOOL_TOKEN,
    inboundEnabled: extra.inboundEnabled ?? false,
    fetchImpl: fake.fetchImpl,
    now,
    timeoutMs: 200,
  });
  return Object.assign(adapter, { outbox: fake.outbox, fake });
};

runContractSuite('bolna', driver(make), make);

const bearer = (token = TOOL_TOKEN) => ({ authorization: `Bearer ${token}` });
const toolHttp = {
  method: 'POST',
  path: '/tools/bolna/ten_x.tag/lookup_orders',
  query: {},
};
const toolBody = (args: Record<string, unknown>) =>
  Buffer.from(
    JSON.stringify({
      execution_id: 'b7140255-af33-4608-8e97-000000000042',
      naaradh_attempt_id: 'att_01TESTATTEMPTAAAAAAAAAAAAA',
      ...args,
    }),
  );

describe('bolna: what it declares', () => {
  it('unsigned webhooks, cancel, no warm transfer; tools only with a tool token; inbound only when switched on', () => {
    expect(make().capabilities()).toMatchObject({
      signedWebhooks: false,
      cancel: true,
      warmTransfer: false,
      midCallTools: true,
      inbound: false,
      reportsDisclosure: false,
      perSecondBilling: false,
    });
    expect(make({ toolToken: undefined }).capabilities()).toMatchObject({
      midCallTools: false,
      inbound: false,
    });
    expect(make({ inboundEnabled: true }).capabilities().inbound).toBe(true);
    expect(make({ inboundEnabled: true, toolToken: undefined }).capabilities().inbound).toBe(false);
  });
});

describe('bolna: events', () => {
  it('"completed" with no conversation is NOT an answered call (Bolna derives status from the carrier)', () => {
    const e = make().parseWebhook(
      {},
      Buffer.from(
        JSON.stringify({
          id: 'x1',
          status: 'completed',
          conversation_duration: 0,
          telephony_data: { duration: 0, hangup_by: 'Callee' },
        }),
      ),
    );
    expect(e).toMatchObject({
      type: 'call.ended',
      reason: 'no_answer',
      answeredBy: 'unknown',
      billableSec: 0,
    });
  });

  it('the agent spoke but the customer never did: answered, with zero human speech (E-25 → not billable)', () => {
    const e = make().parseWebhook(
      {},
      Buffer.from(
        JSON.stringify({
          id: 'x2',
          status: 'completed',
          conversation_duration: 28,
          transcript: 'assistant: Hello?\nassistant: Are you still there?\n',
        }),
      ),
    );
    expect(e).toMatchObject({ type: 'call.ended', answeredBy: 'human', humanSpeechSec: 0 });
  });

  it('statuses that carry nothing are acknowledged and ignored; failures never quote vendor text', () => {
    const a = make();
    for (const status of ['queued', 'initiated', 'scheduled', 'call-disconnected'])
      expect(a.parseWebhook({}, Buffer.from(JSON.stringify({ id: 'x3', status })))).toBeNull();
    const failed = a.parseWebhook(
      {},
      Buffer.from(
        JSON.stringify({
          id: 'x4',
          status: 'failed',
          error_message: `could not reach ${FAKE_IN.customer}`,
        }),
      ),
    );
    expect(failed).toMatchObject({ type: 'call.failed', code: 'failed', retryable: true });
    expect(JSON.stringify(failed)).not.toContain(FAKE_IN.customer);
    expect(
      a.parseWebhook({}, Buffer.from(JSON.stringify({ id: 'x5', status: 'balance-low' }))),
    ).toMatchObject({ type: 'call.failed', code: 'balance_low', retryable: false });
    expect(() => a.parseWebhook({}, Buffer.from('{"hello":1}'))).toThrow();
  });

  it('typed dispositions come back as numbers and booleans; cost is what the wallet was charged', async () => {
    const a = make();
    const ref = await a.placeCall(baseRequest());
    const snap = await a.fetchCall(ref);
    expect(snap.result).toMatchObject({
      extracted: { outcome: 'confirmed', confidence: 0.95 },
      vendorCost: { minor: 2, currency: 'USD' },
    });
    expect(snap.result?.transcript).toEqual([
      expect.objectContaining({ role: 'agent' }),
      { role: 'customer', text: 'Haan, order bhej dijiye.', startMs: 0 },
    ]);
  });

  it('a call still being post-processed is ended but not final: no result yet', async () => {
    const a = make();
    const ref = await a.placeCall(baseRequest());
    const x = a.fake.executions.get(ref.callId);
    if (x !== undefined) a.fake.executions.set(ref.callId, { ...x, status: 'call-disconnected' });
    expect(await a.fetchCall(ref)).toMatchObject({ status: 'ended', result: null });
    expect(await a.fetchCall({ vendor: 'bolna', callId: 'nope' })).toMatchObject({
      status: 'not_found',
    });
  });
});

describe('bolna: what we send', () => {
  it('a call carries the slots, our attempt id and idempotency key, bypasses Bolna’s own scheduling, and is findable again', async () => {
    const a = make();
    const req = baseRequest({ variables: { amount: 499, customer_name: 'Test' } });
    const ref = await a.placeCall(req);
    const sent = a.fake.requests.find((r) => r.path === '/call')?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      recipient_phone_number: FAKE_IN.customer,
      from_phone_number: FAKE_IN.merchant,
      bypass_call_guardrails: true,
      user_data: {
        amount: 499,
        customer_name: 'Test',
        naaradh_attempt_id: 'att_test',
        naaradh_idempotency_key: req.idempotencyKey,
      },
    });
    expect(await a.findCallByIdempotencyKey(req.idempotencyKey)).toMatchObject({
      ref: { callId: ref.callId },
      attemptId: 'att_test',
    });
    expect(await a.findCallByIdempotencyKey('never-sent')).toBeNull();
  });

  it('an agent keeps the greeting template, binds our webhook, maps tools to custom functions and the result schema to dispositions', async () => {
    const a = make();
    await a.createAgent({
      name: 'ten_x:cod_confirm:hi-IN:v1',
      locale: 'hi-IN',
      systemPrompt: 'rules',
      firstUtterance: 'Namaste {{customer_name}}, main ek automated AI assistant hoon.',
      voiceId: 'default',
      maxDurationSec: 180,
      webhookUrl: 'https://hooks.test/engine/bolna/ten_x.tag',
      tools: [
        {
          name: 'create_ticket',
          description: 'Open a ticket.',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              callback_requested: { type: 'boolean' },
              days_ahead: { type: 'integer' },
            },
            required: ['summary'],
          },
          url: 'https://voice.test/tools/bolna/ten_x.tag/create_ticket',
          timeoutMs: 3000,
          fillerUtterance: 'Ek second.',
        },
      ],
      extraction: {
        name: 'cod_confirm_v1',
        schema: {
          type: 'object',
          properties: {
            outcome: { type: 'string', enum: ['confirmed', 'cancelled'] },
            confidence: { type: 'number' },
          },
        },
      },
    });
    const agent = a.fake.requests.find((r) => r.path === '/v2/agent')?.body as {
      agent_config: Record<string, unknown> & {
        tasks: { tools_config: Record<string, unknown>; task_config: Record<string, unknown> }[];
      };
      agent_prompts: unknown;
    };
    expect(agent.agent_config).toMatchObject({
      agent_welcome_message: expect.stringContaining('{{customer_name}}'),
      webhook_url: 'https://hooks.test/engine/bolna/ten_x.tag',
    });
    const task = agent.agent_config.tasks[0];
    expect(task?.task_config).toMatchObject({ call_terminate: 180, voicemail: true });
    expect(task?.tools_config).toMatchObject({
      transcriber: { language: 'hi' },
      api_tools: {
        tools: [
          {
            name: 'create_ticket',
            key: 'custom_task',
            pre_call_message: 'Ek second.',
            value: {
              method: 'POST',
              url: 'https://voice.test/tools/bolna/ten_x.tag/create_ticket',
              api_token: `Bearer ${TOOL_TOKEN}`,
              param: {
                execution_id: '%(execution_id)s',
                summary: '%(summary)s',
                callback_requested__b: '%(callback_requested)s',
                days_ahead__i: '%(days_ahead)i',
              },
            },
          },
        ],
      },
    });
    const dispositions = a.fake.requests.find((r) => r.path === '/dispositions/bulk')?.body;
    expect(dispositions).toMatchObject({
      agent_id: 'agent-0001',
      dispositions: [
        {
          name: 'outcome',
          is_objective: true,
          objective_options: [{ value: 'confirmed' }, { value: 'cancelled' }],
        },
        { name: 'confidence__f', is_subjective: true, subjective_type: 'numeric' },
      ],
    });
  });

  it('a 4xx is our mistake: not retryable, never mistaken for an outage', async () => {
    const a = new BolnaAdapter({
      apiKey: KEY,
      now,
      fetchImpl: async () => new Response('{"message":"agent_id is required"}', { status: 400 }),
    });
    const err = await a.placeCall(baseRequest()).catch((e: unknown) => e);
    expect(isNaaradhError(err) && err.code === 'INTERNAL' && !err.retryable).toBe(true);
  });

  it('recordings are fetched with our key only from Bolna’s own host', () => {
    const a = make();
    expect(a.recordingRequestHeaders('https://api.bolna.test/recordings/call/x')).toEqual({
      authorization: `Bearer ${KEY}`,
    });
    expect(a.recordingRequestHeaders('https://evil.test/recordings/call/x')).toEqual({});
    expect(a.recordingRequestHeaders('not a url')).toEqual({});
  });
});

describe('bolna: mid-call tools (ADR-0006)', () => {
  it('the bearer we gave Bolna authenticates the call; the tool comes from OUR url; typed args are restored', () => {
    const call = make().parseToolCall(
      bearer(),
      toolBody({
        order_ref: '1001',
        callback_requested__b: 'True',
        days_ahead__i: '3',
        note: 'None',
      }),
      toolHttp,
    );
    expect(call).toMatchObject({
      vendor: 'bolna',
      vendorCallId: 'b7140255-af33-4608-8e97-000000000042',
      tool: 'lookup_orders',
      args: { order_ref: '1001', callback_requested: true, days_ahead: 3 },
      attemptId: 'att_01TESTATTEMPTAAAAAAAAAAAAA',
    });
    expect(call.args).not.toHaveProperty('note');
    expect(call.args).not.toHaveProperty('execution_id');
  });

  it('a wrong, missing or empty token is refused before anything is parsed (invariant 9)', () => {
    const a = make();
    for (const h of [bearer('w'.repeat(40)), {}, { authorization: 'Bearer ' }])
      expect(() => a.parseToolCall(h, toolBody({}), toolHttp)).toThrow(SignatureInvalidError);
    expect(() =>
      make({ toolToken: undefined }).parseToolCall(bearer(), toolBody({}), toolHttp),
    ).toThrow(SignatureInvalidError);
  });

  it('a retry within seconds keeps its id; the same lookup again later in the call is a new invocation', () => {
    let t = NOW.getTime();
    const fake = fakeBolna();
    const a = new BolnaAdapter({
      apiKey: KEY,
      toolToken: TOOL_TOKEN,
      fetchImpl: fake.fetchImpl,
      now: () => new Date(t),
    });
    const id = () =>
      a.parseToolCall(bearer(), toolBody({ order_ref: '1001' }), toolHttp).toolCallId;
    const first = id();
    expect(id()).toBe(first);
    t += 40_000; // verify_caller happened in between
    expect(id()).not.toBe(first);
  });

  it('a transfer target never reaches the model', () => {
    const res = make().formatToolResult({
      ok: true,
      data: {},
      say: 'Connecting you now.',
      action: { kind: 'transfer', toE164: FAKE_IN.transferTarget, warmSummary: null },
    });
    expect(res.body).not.toContain(FAKE_IN.transferTarget);
  });
});

describe('bolna: inbound (off until verified, Q-34)', () => {
  const http = (query: Record<string, string>, bound?: string) => ({
    method: 'GET',
    path: '/inbound/bolna',
    query,
    ...(bound === undefined ? {} : { boundCalledE164: bound }),
  });

  it('switched off: a lookup is refused loudly, never half-answered', () => {
    expect(() =>
      make().parseInboundRequest(bearer(), Buffer.alloc(0), http({}, FAKE_IN.merchant)),
    ).toThrow(EngineUnavailable);
  });

  it('the called number comes only from the URL we signed; the caller from Bolna; a lost "+" is restored', () => {
    const a = make({ inboundEnabled: true });
    const req = a.parseInboundRequest(
      bearer(),
      Buffer.alloc(0),
      http(
        { contact_number: ` ${FAKE_IN.customer.slice(1)}`, execution_id: 'ex-1' },
        FAKE_IN.merchant,
      ),
    );
    expect(req).toMatchObject({
      calledE164: FAKE_IN.merchant,
      callerE164: FAKE_IN.customer,
      vendorCallId: 'ex-1',
    });
    expect(
      a.parseInboundRequest(
        bearer(),
        Buffer.alloc(0),
        http({ contact_number: 'anonymous', execution_id: 'ex-2' }, FAKE_IN.merchant),
      ).callerE164,
    ).toBeNull();
    // No verified number in the URL → no tenant → no answer (invariant 16).
    expect(() =>
      a.parseInboundRequest(bearer(), Buffer.alloc(0), http({ execution_id: 'ex-3' })),
    ).toThrow();
    expect(() =>
      a.parseInboundRequest(bearer('w'.repeat(40)), Buffer.alloc(0), http({}, FAKE_IN.merchant)),
    ).toThrow(SignatureInvalidError);
  });

  it('the decision becomes the agent: prompt and greeting are variables; a refusal speaks, never dead air (E-92)', () => {
    const a = make({ inboundEnabled: true });
    const answer = JSON.parse(
      a.formatInboundResponse({
        kind: 'answer',
        attemptId: 'att_1',
        firstUtterance: 'Hello, I am an automated AI assistant and this call is recorded.',
        systemPrompt: 'rules',
        variables: { brand: 'Acme' },
        tools: [],
        maxDurationSec: 300,
        locale: 'en-IN',
        voiceId: null,
        webhookUrl: 'https://hooks.test/x',
      }).body,
    ) as Record<string, string>;
    expect(answer).toMatchObject({
      brand: 'Acme',
      naaradh_attempt_id: 'att_1',
      [INBOUND_PROMPT_VAR]: 'rules',
      [INBOUND_GREETING_VAR]: expect.stringContaining('automated AI assistant'),
    });
    const closed = JSON.parse(
      a.formatInboundResponse({ kind: 'closed', message: 'We are closed.', locale: 'en-IN' }).body,
    ) as Record<string, string>;
    expect(closed[INBOUND_GREETING_VAR]).toBe('We are closed.');
    const forward = a.formatInboundResponse({
      kind: 'forward',
      toE164: FAKE_IN.transferTarget,
      announcement: null,
    });
    expect(forward.body).not.toContain(FAKE_IN.transferTarget);
    expect((JSON.parse(forward.body) as Record<string, string>)[INBOUND_GREETING_VAR]).not.toBe('');
  });

  it('attaching a number creates a variable-prompt agent with our lookup URL and links the number', async () => {
    const a = make({ inboundEnabled: true });
    const ref = await a.attachInboundNumber({
      e164: FAKE_IN.merchant,
      inboundUrl: 'https://voice.test/inbound/bolna?called=x&tag=y',
      agent: {
        name: 'inbound',
        locale: 'en-IN',
        systemPrompt: '',
        firstUtterance: '',
        voiceId: 'default',
        maxDurationSec: 300,
      },
    });
    expect(ref).toEqual({ vendor: 'bolna', agentId: 'agent-0001' });
    const agent = a.fake.requests.find((r) => r.path === '/v2/agent')?.body as {
      agent_config: Record<string, unknown>;
      agent_prompts: { task_1: { system_prompt: string } };
    };
    expect(agent.agent_config).toMatchObject({
      agent_welcome_message: `{${INBOUND_GREETING_VAR}}`,
      ingest_source_config: {
        source_type: 'api',
        source_url: 'https://voice.test/inbound/bolna?called=x&tag=y',
        source_auth_token: TOOL_TOKEN,
      },
    });
    expect(agent.agent_prompts.task_1.system_prompt).toBe(`{${INBOUND_PROMPT_VAR}}`);
    expect(a.fake.requests.find((r) => r.path === '/inbound/setup')?.body).toEqual({
      agent_id: 'agent-0001',
      phone_number_id: 'pn-0001',
    });
  });
});
