import { describe, expect, it } from 'vitest';
import { baseRequest, driver, runContractSuite } from '@naaradh/engine-harness';
import { isNaaradhError, SignatureInvalidError } from '@naaradh/shared';
import { FAKE_US } from '@naaradh/shared/test/fake-phones';
import { RetellAdapter } from '../src/index.js';
import { signRetell } from '../src/signature.js';
import { fakeRetell } from './fake-retell.js';

/**
 * P6-ENG-1 — the Retell adapter against the shared engine contract (AGENTS §10), driven by a
 * stand-in for Retell's API (./fake-retell.ts, shaped from the published reference until
 * real payloads are recorded). Transfer scenarios are skipped because Retell declares no warm
 * transfer; the disclosure event because it declares it cannot report one.
 */

const KEY = 'key_retell_test_0123456789abcdef';
const NOW = new Date('2026-09-14T16:01:00Z');
const now = () => NOW;

const make = () => {
  const fake = fakeRetell(KEY, now);
  const adapter = new RetellAdapter({
    apiKey: KEY,
    fetchImpl: fake.fetchImpl,
    now,
    timeoutMs: 200,
  });
  return Object.assign(adapter, { outbox: fake.outbox, fake });
};

runContractSuite('retell', driver(make), make);

const signed = (body: unknown, key = KEY, at = NOW.getTime()) => {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return { rawBody, headers: { 'x-retell-signature': signRetell(key, rawBody, at) } };
};

const toolCall = (args: Record<string, unknown>) => ({
  name: 'lookup_orders',
  args,
  call: { call_id: 'call_000042', metadata: { call_id: 'att_01TESTATTEMPTAAAAAAAAAAAAA' } },
});

describe('retell: what it declares it cannot do', () => {
  it('no inbound, no warm transfer, no cancel; signed webhooks; disclosure inferred', () => {
    expect(make().capabilities()).toMatchObject({
      inbound: false,
      warmTransfer: false,
      cancel: false,
      midCallTools: true,
      signedWebhooks: true,
      reportsDisclosure: false,
      perSecondBilling: false,
    });
  });

  it('an inbound request is refused loudly, never half-answered (E-92)', () => {
    expect(() => make().parseInboundRequest()).toThrow(/not supported/);
  });
});

describe('retell: mid-call tools (ADR-0006)', () => {
  it('a signed tool call is normalised; the attempt id comes from our metadata', () => {
    const d = signed(toolCall({ order_ref: '1001' }));
    expect(make().parseToolCall(d.headers, d.rawBody)).toMatchObject({
      vendor: 'retell',
      vendorCallId: 'call_000042',
      tool: 'lookup_orders',
      args: { order_ref: '1001' },
      attemptId: 'att_01TESTATTEMPTAAAAAAAAAAAAA',
    });
  });

  it('a retried invocation keeps its id; different arguments get a different one', () => {
    const a = make();
    const first = signed(toolCall({ order_ref: '1001' }));
    const again = signed(toolCall({ order_ref: '1001' }));
    const other = signed(toolCall({ order_ref: '1002' }));
    const id = (d: typeof first) => a.parseToolCall(d.headers, d.rawBody).toolCallId;
    expect(id(first)).toBe(id(again));
    expect(id(first)).not.toBe(id(other));
  });

  it('lookup → verify → the same lookup again is a NEW invocation, not a replay of the refusal', () => {
    const a = make();
    const at = (turns: number) =>
      signed({
        ...toolCall({ order_ref: '1001' }),
        call: {
          ...toolCall({}).call,
          transcript_object: Array.from({ length: turns }, () => ({ role: 'user', content: 'x' })),
        },
      });
    const id = (d: ReturnType<typeof at>) => a.parseToolCall(d.headers, d.rawBody).toolCallId;
    expect(id(at(4))).toBe(id(at(4))); // Retell retrying the same invocation
    expect(id(at(4))).not.toBe(id(at(7))); // asked again after verify_caller
  });

  it('a tampered, foreign-key or stale signature is refused (invariant 9)', () => {
    const a = make();
    const good = signed(toolCall({ order_ref: '1001' }));
    const tampered = {
      ...good,
      rawBody: Buffer.from(good.rawBody.toString().replace('1001', '9999')),
    };
    const foreign = signed(toolCall({ order_ref: '1001' }), 'someone-elses-key-0000000000000');
    const stale = signed(toolCall({ order_ref: '1001' }), KEY, NOW.getTime() - 6 * 60_000);
    for (const d of [tampered, foreign, stale])
      expect(() => a.parseToolCall(d.headers, d.rawBody)).toThrow(SignatureInvalidError);
    expect(() => a.parseToolCall({}, good.rawBody)).toThrow(SignatureInvalidError);
  });

  it('a transfer target never reaches the model', () => {
    const res = make().formatToolResult({
      ok: true,
      data: { transfer: true },
      say: 'Connecting you now.',
      action: { kind: 'transfer', toE164: FAKE_US.transferTarget, warmSummary: 'manager' },
    });
    expect(res.body).toContain('Connecting you now.');
    expect(res.body).not.toContain(FAKE_US.transferTarget);
    expect(JSON.parse(res.body)).toMatchObject({ action: { kind: 'transfer', supported: false } });
  });
});

describe('retell: what we send', () => {
  it('an agent keeps the greeting template, binds our webhook URL and asks for our result fields', async () => {
    const a = make();
    await a.createAgent({
      name: 'ten_x:abandoned_cart:en-US:v1',
      locale: 'en-US',
      systemPrompt: 'rules',
      firstUtterance:
        'Hi {{customer_name}}, this is an automated AI assistant; this call is recorded.',
      voiceId: 'default',
      maxDurationSec: 180,
      webhookUrl: 'https://hooks.test/engine/retell/ten_x.tag',
      extraction: {
        name: 'abandoned_cart_v1',
        schema: {
          type: 'object',
          properties: {
            outcome: { type: 'string', enum: ['will_complete', 'not_interested'] },
            confidence: { type: 'number' },
          },
          required: ['outcome', 'confidence'],
        },
      },
    });
    const llm = a.fake.requests.find((r) => r.path === '/create-retell-llm')?.body as Record<
      string,
      unknown
    >;
    const agent = a.fake.requests.find((r) => r.path === '/create-agent')?.body as Record<
      string,
      unknown
    >;
    expect(llm['begin_message']).toContain('{{customer_name}}');
    expect(llm['general_tools']).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'end_call' })]),
    );
    expect(agent).toMatchObject({
      webhook_url: 'https://hooks.test/engine/retell/ten_x.tag',
      language: 'en-US',
      max_call_duration_ms: 180_000,
      enable_voicemail_detection: true,
    });
    expect(agent['post_call_analysis_data']).toEqual([
      expect.objectContaining({
        type: 'enum',
        name: 'outcome',
        choices: ['will_complete', 'not_interested'],
      }),
      expect.objectContaining({ type: 'number', name: 'confidence' }),
    ]);
  });

  it('a call carries string variables and our idempotency key, and is findable by it', async () => {
    const a = make();
    const req = baseRequest({
      to: FAKE_US.customer,
      locale: 'en-US',
      variables: { amount: 499, name: 'Test' },
    });
    const ref = await a.placeCall(req);
    const sent = a.fake.requests.find((r) => r.path === '/v2/create-phone-call')?.body as Record<
      string,
      unknown
    >;
    expect(sent['retell_llm_dynamic_variables']).toEqual({ amount: '499', name: 'Test' });
    expect(sent['metadata']).toMatchObject({
      call_id: 'att_test',
      idempotency_key: req.idempotencyKey,
    });
    expect(await a.findCallByIdempotencyKey(req.idempotencyKey)).toMatchObject({
      ref: { callId: ref.callId },
    });
    expect(await a.findCallByIdempotencyKey('never-sent')).toBeNull();
  });

  it('a 4xx is our mistake: not retryable, never mistaken for an outage', async () => {
    const a = new RetellAdapter({
      apiKey: KEY,
      now,
      fetchImpl: async () => new Response('{"error":"from_number not found"}', { status: 422 }),
    });
    const err = await a.placeCall(baseRequest()).catch((e: unknown) => e);
    expect(isNaaradhError(err) && err.code === 'INTERNAL' && !err.retryable).toBe(true);
  });
});

describe('retell: mapping details', () => {
  const ended = (call: Record<string, unknown>) => {
    const d = signed({ event: 'call_analyzed', call: { call_id: 'c1', ...call } });
    return make().parseWebhook(d.headers, d.rawBody);
  };

  it('reasons map to ours, and the recorded outcome wins where it is also an end reason', () => {
    const base = { start_timestamp: Date.parse('2026-09-14T16:00:00Z'), duration_ms: 20_000 };
    expect(ended({ ...base, disconnection_reason: 'user_hangup' })).toMatchObject({
      reason: 'customer_hangup',
      answeredBy: 'human',
    });
    expect(ended({ ...base, disconnection_reason: 'max_duration_reached' })).toMatchObject({
      reason: 'max_duration',
    });
    expect(ended({ ...base, disconnection_reason: 'error_llm_websocket_open' })).toMatchObject({
      reason: 'engine_error',
    });
    expect(
      ended({
        ...base,
        disconnection_reason: 'agent_hangup',
        call_analysis: { custom_analysis_data: { outcome: 'recording_refused' } },
      }),
    ).toMatchObject({ reason: 'recording_refused' });
    expect(
      ended({ disconnection_reason: 'invalid_destination', start_timestamp: null }),
    ).toMatchObject({
      reason: 'invalid_number',
      answeredBy: 'unknown',
      billableSec: 0,
    });
  });

  it('cost is kept in dollars, and human speech is measured from the words', () => {
    const e = ended({
      start_timestamp: Date.parse('2026-09-14T16:00:00Z'),
      duration_ms: 30_000,
      disconnection_reason: 'agent_hangup',
      call_cost: { combined_cost: 23.4, total_duration_seconds: 30 },
      transcript_object: [
        { role: 'user', content: 'yes', words: [{ word: 'yes', start: 2, end: 8.5 }] },
      ],
    });
    expect(e).toMatchObject({
      vendorCost: { minor: 23, currency: 'USD' },
      humanSpeechSec: 6.5,
      billableSec: 30,
    });
  });
});
