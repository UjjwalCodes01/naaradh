import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  driver,
  runContractSuite,
  runInboundContractSuite,
  baseRequest,
} from '@naaradh/engine-harness';
import { isNaaradhError } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { SimulatorAdapter } from '../src/index.js';

const SECRET = 'sim_test_secret';
const make = () =>
  new SimulatorAdapter({ webhookSecret: SECRET, now: () => new Date('2026-09-14T06:30:00Z') });

runContractSuite('simulator', driver(make), make);

const signed = (body: unknown) => {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-sim-signature': createHmac('sha256', SECRET).update(rawBody).digest('hex'),
    },
  };
};
const at = '2026-09-14T06:30:00.000Z';
runInboundContractSuite('simulator', {
  make,
  context: {
    callId: 'sim_in_contract',
    ...signed({ call_id: 'sim_in_contract', to: FAKE_IN.merchant, from: FAKE_IN.customer, at }),
  },
  withheldContext: signed({ call_id: 'sim_in_withheld', to: FAKE_IN.merchant, from: null, at }),
  toolCall: {
    callId: 'sim_in_contract',
    toolCallId: 'sim_in_contract:tool:0',
    ...signed({
      call_id: 'sim_in_contract',
      attempt_id: 'att_x',
      tool_call_id: 'sim_in_contract:tool:0',
      tool: 'lookup_orders',
      args: { order_ref: '1001' },
    }),
  },
  tamper: (d) => ({ rawBody: d.rawBody, headers: { ...d.headers, 'x-sim-signature': 'deadbeef' } }),
});

describe('simulator specifics', () => {
  it('refuses to dial anything outside the reserved fake ranges — the last line of defence', async () => {
    const sim = make();
    const outOfRange = '+916100000001'; // naaradh-pii-allow: negative fixture, must be refused
    await expect(sim.placeCall(baseRequest({ to: outOfRange }))).rejects.toThrow(
      /not in a reserved test range/,
    );
    expect(sim.outbox).toHaveLength(0);
  });

  it('is idempotent on the idempotency key (invariant 10)', async () => {
    const sim = make();
    const req = baseRequest();
    const a = await sim.placeCall(req);
    const b = await sim.placeCall(req);
    expect(b.callId).toBe(a.callId);
    // One call's worth of events, not two.
    expect(
      sim.outbox.filter((d) => d.headers['x-sim-event-id']?.endsWith(':4')).length,
    ).toBeLessThanOrEqual(1);
  });

  it('after an uncertain dispatch, the call is findable by idempotency key and has ended', async () => {
    const sim = make();
    const req = baseRequest({ variables: { __scenario: 'timeout-uncertain' } });
    await expect(sim.placeCall(req)).rejects.toSatisfy(
      (e: unknown) => isNaaradhError(e) && e.code === 'DISPATCH_UNCERTAIN',
    );
    const found = await sim.findCallByIdempotencyKey(req.idempotencyKey);
    expect(found).toMatchObject({ status: 'ended', answeredBy: 'human', endReason: 'completed' });
    expect(await sim.findCallByIdempotencyKey('nope')).toBeNull();
  });

  it('webhook-missing: the outbox has no ended event but fetchCall on the same instance does', async () => {
    const sim = make();
    const ref = await sim.placeCall(baseRequest({ variables: { __scenario: 'webhook-missing' } }));
    const types = sim.outbox.map(
      (d) => (JSON.parse(d.rawBody.toString()) as { event: { type: string } }).event.type,
    );
    expect(types).not.toContain('call.ended');
    expect(await sim.fetchCall(ref)).toMatchObject({
      status: 'ended',
      endReason: 'completed',
      durationSec: 42,
    });
  });

  it('cancelCall while ringing ends the call as cancelled (E-40) and is a no-op after answer', async () => {
    const sim = new SimulatorAdapter({ webhookSecret: SECRET, cancel: true });
    // Scenarios run to completion synchronously, so cancel-after-answer is the observable case.
    const ref = await sim.placeCall(baseRequest());
    await sim.cancelCall(ref);
    expect(await sim.fetchCall(ref)).toMatchObject({ status: 'ended', endReason: 'completed' });
  });

  it('selects the scenario from the number suffix when none is given', async () => {
    const sim = make();
    await sim.placeCall(baseRequest({ to: FAKE_IN.optedOut }));
    const last = JSON.parse(sim.outbox.at(-1)?.rawBody.toString() ?? '{}') as {
      event: { reason?: string };
    };
    expect(last.event.reason).toBe('opt_out');
  });

  it('reports vendor cost per call for margin tracking (E-33)', async () => {
    const sim = make();
    await sim.placeCall(baseRequest());
    const last = sim.outbox.at(-1);
    const ev = sim.parseWebhook(last?.headers ?? {}, last?.rawBody ?? Buffer.alloc(0));
    expect(ev.type).toBe('call.ended');
    if (ev.type === 'call.ended') expect(ev.vendorCost).toEqual({ minor: 270, currency: 'INR' });
  });
});
