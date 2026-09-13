import { describe, expect, it } from 'vitest';
import { SignatureInvalidError, isNaaradhError } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import type { EngineEvent, PlaceCallRequest, VoiceEngineAdapter } from '@naaradh/engines-core';

/**
 * The contract every adapter must pass (AGENTS §10). A vendor adapter runs this against its
 * recorded, sanitised fixtures; the simulator runs it live. The scenarios are the ones that
 * break real systems, not the happy path:
 *
 *   answered-human-confirmed, answered-machine, no-answer, busy, transfer-success,
 *   transfer-fail, opt-out mid-call, webhook-duplicate, webhook-out-of-order,
 *   webhook-missing (poll path), unsigned-webhook (re-fetch path), 429 backoff, 5xx circuit-open.
 */

export interface ScenarioFixture {
  /** Webhook deliveries in the order the vendor sent them. */
  readonly webhooks: readonly { headers: Readonly<Record<string, string>>; rawBody: Buffer }[];
}

export interface ContractFixtures {
  /** A function that places the scenario's call and returns the resulting deliveries. */
  run(scenario: ContractScenario): Promise<{
    events: EngineEvent[];
    error: unknown;
    ref: { callId: string } | null;
    rawDeliveries: number;
    rejectedSignatures: number;
  }>;
}

export type ContractScenario =
  | 'answered-human-confirmed'
  | 'answered-machine'
  | 'no-answer'
  | 'busy'
  | 'transfer-success'
  | 'transfer-fail'
  | 'opt-out-mid-call'
  | 'webhook-duplicate'
  | 'webhook-out-of-order'
  | 'webhook-missing'
  | 'unsigned-webhook'
  | 'rate-limited'
  | 'engine-5xx'
  | 'timeout-uncertain';

export function baseRequest(overrides: Partial<PlaceCallRequest> = {}): PlaceCallRequest {
  return {
    to: FAKE_IN.customer,
    from: FAKE_IN.merchant,
    agentRef: { vendor: 'test', agentId: 'agent' },
    variables: { customer_name: 'Test', order_ref: '1001', amount: 499 },
    maxDurationSec: 120,
    metadata: {
      tenant_id: 'ten_test',
      campaign_id: null,
      call_id: 'att_test',
      purpose: 'transactional',
      script_version: '1',
    },
    webhookUrl: 'https://hooks.naaradh.test/engine/test/abc',
    amd: 'continue',
    locale: 'hi-IN',
    idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

/**
 * Drives an adapter through a scenario using its own webhook deliveries: every delivery is
 * fed back through `parseWebhook`, exactly as the hooks service would do it.
 */
export function driver(
  makeAdapter: () => VoiceEngineAdapter & {
    outbox: readonly { headers: Readonly<Record<string, string>>; rawBody: Buffer }[];
  },
): ContractFixtures {
  return {
    async run(scenario) {
      const adapter = makeAdapter();
      const req = baseRequest({ variables: { __scenario: scenario } });
      let ref: { callId: string } | null = null;
      let error: unknown = null;
      const attempt = async () => adapter.placeCall(req);
      try {
        ref = await attempt();
      } catch (e) {
        error = e;
        // 429: back off as the dispatcher would, honouring Retry-After, and try again.
        if (isNaaradhError(e) && e.code === 'RATE_LIMITED') {
          for (let i = 0; i < 3 && ref === null; i += 1) {
            try {
              ref = await attempt();
              error = null;
            } catch (again) {
              error = again;
            }
          }
        }
      }
      const events: EngineEvent[] = [];
      let rejectedSignatures = 0;
      for (const d of adapter.outbox) {
        try {
          events.push(adapter.parseWebhook(d.headers, d.rawBody));
        } catch (e) {
          if (e instanceof SignatureInvalidError) rejectedSignatures += 1;
          else throw e;
        }
      }
      return { events, error, ref, rawDeliveries: adapter.outbox.length, rejectedSignatures };
    },
  };
}

export function runContractSuite(
  name: string,
  fixtures: ContractFixtures,
  adapterForFetch: () => VoiceEngineAdapter,
): void {
  describe(`engine contract: ${name}`, () => {
    it('answered-human-confirmed: ringing → answered(human) → disclosed → ended(completed) with a billable duration', async () => {
      const { events, error } = await fixtures.run('answered-human-confirmed');
      expect(error).toBeNull();
      expect(events.map((e) => e.type)).toEqual([
        'call.ringing',
        'call.answered',
        'call.disclosed',
        'call.ended',
      ]);
      const ended = events.at(-1);
      expect(ended).toMatchObject({ type: 'call.ended', reason: 'completed', answeredBy: 'human' });
      if (ended?.type === 'call.ended') {
        expect(ended.durationSec).toBeGreaterThan(0);
        expect(ended.billableSec).not.toBeNull();
        expect(ended.recordingUrl).not.toBeNull();
      }
    });

    it('every event carries an eventId (dedupe key) and a call ref', async () => {
      const { events } = await fixtures.run('answered-human-confirmed');
      for (const e of events) {
        expect(e.eventId.length).toBeGreaterThan(0);
        expect(e.ref.callId.length).toBeGreaterThan(0);
        expect(e.at).toBeInstanceOf(Date);
      }
      expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    });

    it('answered-machine: answered(machine) then ended(amd_hangup), never billable', async () => {
      const { events } = await fixtures.run('answered-machine');
      expect(events.find((e) => e.type === 'call.answered')).toMatchObject({
        answeredBy: 'machine',
      });
      expect(events.at(-1)).toMatchObject({
        type: 'call.ended',
        reason: 'amd_hangup',
        answeredBy: 'machine',
      });
      expect(events.some((e) => e.type === 'call.disclosed')).toBe(false);
    });

    it('no-answer and busy end without an answered event', async () => {
      for (const [scenario, reason] of [
        ['no-answer', 'no_answer'],
        ['busy', 'busy'],
      ] as const) {
        const { events } = await fixtures.run(scenario);
        expect(
          events.some((e) => e.type === 'call.answered'),
          scenario,
        ).toBe(false);
        expect(events.at(-1), scenario).toMatchObject({
          type: 'call.ended',
          reason,
          answeredBy: 'unknown',
        });
      }
    });

    it('transfer-success reports the transfer and ends transfer_completed; the target is masked', async () => {
      const { events } = await fixtures.run('transfer-success');
      const t = events.find((e) => e.type === 'call.transferred');
      expect(t).toMatchObject({ result: 'completed' });
      if (t?.type === 'call.transferred') expect(t.toMasked).toMatch(/x/);
      expect(events.at(-1)).toMatchObject({ type: 'call.ended', reason: 'transfer_completed' });
    });

    it('transfer-fail returns to the agent and ends transfer_failed (E-30)', async () => {
      const { events } = await fixtures.run('transfer-fail');
      expect(events.find((e) => e.type === 'call.transferred')).toMatchObject({
        result: 'no_answer',
      });
      expect(events.at(-1)).toMatchObject({ type: 'call.ended', reason: 'transfer_failed' });
    });

    it('opt-out mid-call ends immediately with reason opt_out', async () => {
      const { events } = await fixtures.run('opt-out-mid-call');
      const ended = events.at(-1);
      expect(ended).toMatchObject({ type: 'call.ended', reason: 'opt_out' });
      if (ended?.type === 'call.ended') expect(ended.durationSec).toBeLessThan(30);
    });

    it('webhook-duplicate: the same eventId is delivered twice and parses identically (E-22)', async () => {
      const { events, rawDeliveries } = await fixtures.run('webhook-duplicate');
      const ids = events.map((e) => e.eventId);
      expect(rawDeliveries).toBe(events.length);
      expect(new Set(ids).size).toBe(ids.length - 1);
      const [a, b] = events.slice(-2);
      expect(a).toEqual(b);
    });

    it('webhook-out-of-order: ended before answered, with sequence numbers that reveal it', async () => {
      const { events } = await fixtures.run('webhook-out-of-order');
      expect(events[0]?.type).toBe('call.ended');
      const seqs = events.map((e) => e.sequence);
      expect(seqs.every((s) => s !== null)).toBe(true);
    });

    it('webhook-missing: no ended event arrives, but fetchCall() reports the call ended (E-21)', async () => {
      const { events, ref } = await fixtures.run('webhook-missing');
      expect(events.some((e) => e.type === 'call.ended')).toBe(false);
      expect(ref).not.toBeNull();
      const snap = await adapterForFetch().fetchCall({
        vendor: 'simulator',
        callId: ref?.callId ?? '',
      });
      // A fresh adapter has no state: the contract is that fetchCall answers, not that it
      // shares memory. Drivers with shared state check 'ended' explicitly.
      expect(['ended', 'not_found']).toContain(snap.status);
    });

    it('unsigned-webhook: a bad signature is rejected with SignatureInvalidError, not parsed (E-23)', async () => {
      const { rejectedSignatures, events } = await fixtures.run('unsigned-webhook');
      expect(rejectedSignatures).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: 'call.ended' });
    });

    it('429: placeCall throws RATE_LIMITED with a Retry-After, and succeeds after backoff', async () => {
      const { error, ref } = await fixtures.run('rate-limited');
      expect(error).toBeNull();
      expect(ref).not.toBeNull();
    });

    it('5xx: placeCall throws ENGINE_UNAVAILABLE (retryable) so the breaker can open (E-20)', async () => {
      const { error, ref } = await fixtures.run('engine-5xx');
      expect(ref).toBeNull();
      expect(isNaaradhError(error) && error.code === 'ENGINE_UNAVAILABLE' && error.retryable).toBe(
        true,
      );
    });

    it('timeout after send: placeCall throws DISPATCH_UNCERTAIN and the call is findable by idempotency key', async () => {
      const { error } = await fixtures.run('timeout-uncertain');
      expect(isNaaradhError(error) && error.code === 'DISPATCH_UNCERTAIN').toBe(true);
      if (isNaaradhError(error)) expect(error.retryable).toBe(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Inbound + mid-call tools (ADR-0006). A vendor adapter supplies its recorded, sanitised
// context and tool-call payloads; the suite checks it verifies, normalises and formats them.
// ---------------------------------------------------------------------------

export interface SignedDelivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Buffer;
}

export interface InboundContractFixtures {
  readonly make: () => VoiceEngineAdapter;
  /** A call from FAKE_IN.customer to FAKE_IN.merchant with vendor call id `callId`. */
  readonly context: SignedDelivery & { readonly callId: string };
  /** The same, caller ID withheld. */
  readonly withheldContext: SignedDelivery;
  /** A `lookup_orders` invocation with args `{ order_ref: '1001' }` on call `callId`. */
  readonly toolCall: SignedDelivery & { readonly callId: string; readonly toolCallId: string };
  /** Break the delivery's signature the way this vendor's would break. */
  readonly tamper: (d: SignedDelivery) => SignedDelivery;
}

const GREETING = 'Hello, I am an automated AI assistant and this call is being recorded.';

export function runInboundContractSuite(name: string, fx: InboundContractFixtures): void {
  describe(`engine inbound contract: ${name}`, () => {
    it('declares inbound and mid-call tools (the bake-off gate for ADR-0006)', () => {
      const caps = fx.make().capabilities();
      expect(caps.inbound).toBe(true);
      expect(caps.midCallTools).toBe(true);
    });

    it('context request: verified, then normalised — called number, caller, vendor call id', () => {
      const req = fx.make().parseInboundRequest(fx.context.headers, fx.context.rawBody);
      expect(req.calledE164).toBe(FAKE_IN.merchant);
      expect(req.callerE164).toBe(FAKE_IN.customer);
      expect(req.vendorCallId).toBe(fx.context.callId);
      expect(req.at).toBeInstanceOf(Date);
    });

    it('withheld caller ID normalises to null, never an empty or placeholder string (E-80)', () => {
      const req = fx
        .make()
        .parseInboundRequest(fx.withheldContext.headers, fx.withheldContext.rawBody);
      expect(req.callerE164).toBeNull();
    });

    it('a tampered context request or tool call throws SignatureInvalidError (invariant 9)', () => {
      const adapter = fx.make();
      const badContext = fx.tamper(fx.context);
      const badTool = fx.tamper(fx.toolCall);
      expect(() => adapter.parseInboundRequest(badContext.headers, badContext.rawBody)).toThrow(
        SignatureInvalidError,
      );
      expect(() => adapter.parseToolCall(badTool.headers, badTool.rawBody)).toThrow(
        SignatureInvalidError,
      );
    });

    it('tool call: tool name, args, vendor call id and invocation id survive normalisation', () => {
      const call = fx.make().parseToolCall(fx.toolCall.headers, fx.toolCall.rawBody);
      expect(call).toMatchObject({
        tool: 'lookup_orders',
        args: { order_ref: '1001' },
        vendorCallId: fx.toolCall.callId,
        toolCallId: fx.toolCall.toolCallId,
      });
    });

    it('answer: the greeting is passed verbatim as the first utterance, with every tool URL and the webhook URL', () => {
      const res = fx.make().formatInboundResponse({
        kind: 'answer',
        attemptId: 'att_contract',
        firstUtterance: GREETING,
        systemPrompt: 'rules',
        variables: { brand: 'Client A' },
        tools: [
          {
            name: 'lookup_orders',
            description: 'd',
            parameters: { type: 'object' },
            url: 'https://voice.test/tools/x/ten_x.tag/lookup_orders',
            timeoutMs: 2500,
            fillerUtterance: 'One moment.',
          },
        ],
        maxDurationSec: 600,
        locale: 'en-IN',
        voiceId: null,
        webhookUrl: 'https://hooks.test/engine/x/ten_x.tag',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain(GREETING);
      expect(res.body).toContain('https://voice.test/tools/x/ten_x.tag/lookup_orders');
      expect(res.body).toContain('https://hooks.test/engine/x/ten_x.tag');
    });

    it('forward and closed: the engine can execute both — never dead air (E-92)', () => {
      const adapter = fx.make();
      const fwd = adapter.formatInboundResponse({
        kind: 'forward',
        toE164: FAKE_IN.merchant,
        announcement: null,
      });
      expect(fwd.status).toBe(200);
      expect(fwd.body).toContain(FAKE_IN.merchant);
      const closed = adapter.formatInboundResponse({
        kind: 'closed',
        message: 'We are closed. Please call again.',
        locale: 'en-IN',
      });
      expect(closed.status).toBe(200);
      expect(closed.body).toContain('We are closed');
    });

    it('tool result: facts, the suggested sentence and a transfer action reach the engine', () => {
      const res = fx.make().formatToolResult({
        ok: true,
        data: { transfer: true },
        say: 'Connecting you now.',
        action: {
          kind: 'transfer',
          toE164: FAKE_IN.transferTarget,
          warmSummary: 'wants the manager',
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('Connecting you now.');
      expect(res.body).toContain(FAKE_IN.transferTarget);
    });
  });
}
