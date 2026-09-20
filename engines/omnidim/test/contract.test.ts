import { describe, expect, it } from 'vitest';
import { baseRequest, driver, runContractSuite } from '@naaradh/engine-harness';
import { EngineUnavailable } from '@naaradh/engines-core';
import { isNaaradhError } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { OmnidimAdapter } from '../src/index.js';
import { FROM_NUMBER_ID, fakeOmnidim } from './fake-omnidim.js';

/**
 * P1-ENG-3 — the OmniDimension adapter against the shared engine contract (AGENTS §10), driven
 * by a stand-in for its API (./fake-omnidim.ts). Outbound only: one unsigned post-call webhook,
 * the outcome from the fetched call log. Transfer, disclosure, bad-signature and live-progress
 * scenarios do not apply and are skipped by capability.
 */

const KEY = 'od-test-0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-09-14T10:31:30Z');
const now = () => NOW;

const make = () => {
  const fake = fakeOmnidim(FAKE_IN.merchant);
  const adapter = new OmnidimAdapter({
    apiKey: KEY,
    baseUrl: 'https://omnidim.test/api/v1',
    fetchImpl: fake.fetchImpl,
    now,
    timeoutMs: 200,
  });
  return Object.assign(adapter, { outbox: fake.outbox, fake });
};

runContractSuite('omnidim', driver(make), make);

describe('omnidim: what it declares', () => {
  it('outbound only: no tools, no inbound, no transfer, no cancel, no live progress, no lookup, nothing signed', () => {
    expect(make().capabilities()).toEqual({
      inbound: false,
      cancel: false,
      warmTransfer: false,
      midCallTools: false,
      perSecondBilling: false,
      recordingToggle: false,
      signedWebhooks: false,
      reportsDisclosure: false,
      progressEvents: false,
      callLookup: false,
    });
  });

  it('inbound and tool requests are refused loudly, never half-answered', () => {
    const a = make();
    expect(() => a.parseInboundRequest()).toThrow(EngineUnavailable);
    expect(() => a.parseToolCall()).toThrow(EngineUnavailable);
  });
});

describe('omnidim: what we send', () => {
  it('dials from the number ID of the gate’s CLI, with string slots and our ids as metadata', async () => {
    const a = make();
    const req = baseRequest({
      agentRef: { vendor: 'omnidim', agentId: '158910' },
      variables: { amount: 499, customer_name: 'Test' },
    });
    const ref = await a.placeCall(req);
    expect(ref.callId).toMatch(/^\d+$/);
    expect(a.fake.requests.find((r) => r.path === '/calls/dispatch')?.body).toEqual({
      agent_id: 158910,
      to_number: FAKE_IN.customer,
      from_number_id: FROM_NUMBER_ID,
      call_context: { amount: '499', customer_name: 'Test' },
      metadata: { naaradh_attempt_id: 'att_test', naaradh_idempotency_key: req.idempotencyKey },
    });
  });

  it('a CLI that is not on the account is refused — never OmniDimension’s default number', async () => {
    const a = make();
    const err = await a
      .placeCall(baseRequest({ from: FAKE_IN.transferTarget }))
      .catch((e: unknown) => e);
    expect(isNaaradhError(err) && err.code === 'INTERNAL' && !err.retryable).toBe(true);
    expect(a.fake.requests.some((r) => r.path === '/calls/dispatch')).toBe(false);
  });

  it('a refusal that arrives as HTTP 200: concurrency is back-off, an empty plan is an outage', async () => {
    const refuse = (body: unknown) =>
      new OmnidimAdapter({
        apiKey: KEY,
        now,
        fetchImpl: async (input) =>
          new Response(
            JSON.stringify(
              (typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url
              ).includes('/phone_number/list')
                ? { phone_numbers: [{ id: 1, phone_number: FAKE_IN.merchant }] }
                : body,
            ),
            { status: 200 },
          ),
      })
        .placeCall(baseRequest())
        .catch((e: unknown) => e);
    const busy = await refuse({ success: false, error: 'Concurrency call limit exceeded' });
    expect(isNaaradhError(busy) && busy.code === 'RATE_LIMITED').toBe(true);
    const broke = await refuse({ success: false, plan_expire: true, error: 'x' });
    expect(isNaaradhError(broke) && broke.code === 'ENGINE_UNAVAILABLE').toBe(true);
  });

  it('an agent: greeting spoken word for word and never interrupted, every outcome webhooked, typed variables', async () => {
    const a = make();
    const ref = await a.createAgent({
      name: 'ten_x:cod_confirm:hi-IN:v1',
      locale: 'hi-IN',
      systemPrompt: 'rules',
      firstUtterance: 'Namaste {{customer_name}}, main ek automated AI assistant hoon.',
      voiceId: 'default',
      maxDurationSec: 180,
      webhookUrl: 'https://hooks.test/engine/omnidim/ten_x.tag',
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
    expect(ref).toEqual({ vendor: 'omnidim', agentId: '158910' });
    expect(a.fake.requests.find((r) => r.path === '/agents/create')?.body).toMatchObject({
      welcome_message: expect.stringContaining('{{customer_name}}'),
      is_welcome_message_dynamic: false,
      is_welcome_message_interruption: false,
      call_type: 'Outgoing',
      transcriber: { language: 'hi', max_call_duration_in_sec: 180 },
      post_call_actions: {
        webhook: {
          enabled: true,
          url: 'https://hooks.test/engine/omnidim/ten_x.tag',
          trigger_call_statuses: expect.arrayContaining(['no_answer', 'busy', 'failed']),
          extracted_variables: [
            { key: 'outcome', prompt: expect.stringContaining('confirmed, cancelled') },
            { key: 'confidence__f', prompt: expect.any(String) },
          ],
        },
      },
    });
  });
});

describe('omnidim: the outcome comes from the fetched call log', () => {
  it('typed variables are restored, "Not provided" dropped, the transcript split, cost in cents', async () => {
    const a = make();
    const ref = await a.placeCall(baseRequest());
    const snap = await a.fetchCall(ref);
    expect(snap).toMatchObject({ status: 'ended', endReason: 'completed', answeredBy: 'human' });
    expect(snap.result).toMatchObject({
      extracted: { outcome: 'confirmed', confidence: 0.95 },
      vendorCost: { minor: 12, currency: 'USD' },
      transcript: [
        expect.objectContaining({ role: 'agent' }),
        { role: 'customer', text: 'Haan, bhej dijiye.', startMs: 0 },
      ],
    });
    expect(snap.result?.extracted).not.toHaveProperty('note');
    expect(await a.fetchCall({ vendor: 'omnidim', callId: '1' })).toMatchObject({
      status: 'not_found',
    });
  });

  it('cannot find a call by our key, and says so (the reconciler waits for the webhook instead)', async () => {
    const a = make();
    const req = baseRequest();
    await a.placeCall(req);
    expect(await a.findCallByIdempotencyKey(req.idempotencyKey)).toBeNull();
  });

  it('the webhook names our attempt; one that names no call at all is refused', () => {
    const a = make();
    const e = a.parseWebhook(
      {},
      Buffer.from(
        JSON.stringify({
          call_id: 7,
          call_request_id: 3166940,
          call_status: 'no-answer',
          call_duration: 0,
          metadata: { naaradh_attempt_id: 'att_01TESTATTEMPTAAAAAAAAAAAAA' },
        }),
      ),
    );
    expect(e).toMatchObject({
      type: 'call.ended',
      reason: 'no_answer',
      attemptId: 'att_01TESTATTEMPTAAAAAAAAAAAAA',
      ref: { callId: '3166940' },
    });
    expect(() => a.parseWebhook({}, Buffer.from('{"call_status":"completed"}'))).toThrow();
  });
});
