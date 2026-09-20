import { describe, expect, it } from 'vitest';
import {
  canDiscussOrder,
  cancellationPolicy,
  describeHours,
  isWithinHours,
  maxIdentity,
  normalisePincode,
  orderNameKey,
  transferPolicy,
  type BusinessHours,
  type CallerState,
  type OrderFacts,
} from '../../src/inbound/policy.js';
import * as C from '../../src/constants.js';

const MINE = 'a'.repeat(64);
const THEIRS = 'b'.repeat(64);

const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({
  id: 'ord_1',
  phoneHash: MINE,
  paymentKind: 'cod',
  fulfillmentStatus: null,
  cancelledAt: null,
  ...o,
});
const caller = (c: Partial<CallerState> = {}): CallerState => ({
  identity: 'caller_id',
  callerHash: MINE,
  verifiedOrderIds: [],
  ...c,
});

describe('identity before information (invariant 17, E-82)', () => {
  it('a caller may discuss orders placed from the number they are calling from', () => {
    expect(canDiscussOrder(caller(), order())).toBe(true);
  });

  it("a caller may NOT discuss someone else's order, however confident they sound", () => {
    expect(canDiscussOrder(caller(), order({ phoneHash: THEIRS }))).toBe(false);
    expect(canDiscussOrder(caller({ identity: 'knowledge' }), order({ phoneHash: THEIRS }))).toBe(
      false,
    );
  });

  it('order number + pincode verification unlocks that ONE order from any number', () => {
    const verified = caller({
      identity: 'knowledge',
      callerHash: THEIRS,
      verifiedOrderIds: ['ord_1'],
    });
    expect(canDiscussOrder(verified, order())).toBe(true);
    expect(canDiscussOrder(verified, order({ id: 'ord_2' }))).toBe(false);
  });

  it('a withheld caller (E-80) can discuss nothing until verified', () => {
    expect(canDiscussOrder(caller({ identity: 'none', callerHash: null }), order())).toBe(false);
  });

  it('an order with no phone on it cannot be matched by caller ID', () => {
    expect(canDiscussOrder(caller(), order({ phoneHash: null }))).toBe(false);
  });

  it('identity only ever goes up within a call', () => {
    expect(maxIdentity('knowledge', 'caller_id')).toBe('knowledge');
    expect(maxIdentity('none', 'caller_id')).toBe('caller_id');
  });
});

describe('agent cancellation (invariant 14, E-84, E-85)', () => {
  it('executes only for an unshipped, uncancelled COD order of this caller with the tenant setting on', () => {
    expect(cancellationPolicy(caller(), order(), true)).toEqual({ kind: 'execute' });
  });

  it('defaults to a ticket when the merchant has not enabled agent cancellation', () => {
    expect(cancellationPolicy(caller(), order(), false)).toEqual({
      kind: 'ticket',
      reason: 'agent_cancel_disabled',
    });
  });

  it('refuses for an order the caller has not proven is theirs', () => {
    expect(cancellationPolicy(caller(), order({ phoneHash: THEIRS }), true)).toEqual({
      kind: 'refuse',
      reason: 'not_verified',
    });
  });

  it('shipped or delivered → ticket (a return, not a cancellation)', () => {
    for (const s of [
      'fulfilled',
      'shipped',
      'in_transit',
      'OUT_FOR_DELIVERY',
      'delivered',
      'partial',
    ]) {
      expect(cancellationPolicy(caller(), order({ fulfillmentStatus: s }), true), s).toEqual({
        kind: 'ticket',
        reason: 'shipped',
      });
    }
  });

  it('prepaid or unknown payment → ticket: a refund moves money, the merchant decides', () => {
    expect(cancellationPolicy(caller(), order({ paymentKind: 'prepaid' }), true)).toEqual({
      kind: 'ticket',
      reason: 'prepaid',
    });
    expect(cancellationPolicy(caller(), order({ paymentKind: 'unknown' }), true)).toEqual({
      kind: 'ticket',
      reason: 'payment_unknown',
    });
  });

  it('an already cancelled order is not cancelled twice', () => {
    expect(cancellationPolicy(caller(), order({ cancelledAt: new Date() }), true)).toEqual({
      kind: 'refuse',
      reason: 'already_cancelled',
    });
  });
});

describe('transfers (invariant 19, E-86, E-87)', () => {
  const hours: BusinessHours = {
    zone: 'Asia/Kolkata',
    days: [1, 2, 3, 4, 5, 6],
    open: '10:00',
    close: '19:00',
  };
  /** Monday 2026-09-14 12:00 IST. */
  const MON_NOON = new Date('2026-09-14T06:30:00Z');
  /** Sunday 2026-09-13 12:00 IST. */
  const SUN_NOON = new Date('2026-09-13T06:30:00Z');
  const target = { id: 'trf_1', active: true, verifiedAt: new Date('2026-09-01'), hours: null };

  it('transfers to a verified, active target inside hours', () => {
    expect(transferPolicy(target, hours, MON_NOON)).toEqual({ transfer: true, targetId: 'trf_1' });
  });

  it('after hours or on a closed day → callback instead', () => {
    expect(transferPolicy(target, hours, new Date('2026-09-14T14:00:00Z'))).toEqual({
      transfer: false,
      reason: 'after_hours',
    }); // 19:30 IST
    expect(transferPolicy(target, hours, SUN_NOON)).toEqual({
      transfer: false,
      reason: 'after_hours',
    });
  });

  it('never to an unverified or inactive target, and not at all without one', () => {
    expect(transferPolicy({ ...target, verifiedAt: null }, hours, MON_NOON)).toEqual({
      transfer: false,
      reason: 'not_verified',
    });
    expect(transferPolicy({ ...target, active: false }, hours, MON_NOON)).toEqual({
      transfer: false,
      reason: 'no_target',
    });
    expect(transferPolicy(null, hours, MON_NOON)).toEqual({ transfer: false, reason: 'no_target' });
  });

  it("a target's own hours override the profile's", () => {
    const evening = {
      ...target,
      hours: { zone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6, 7], open: '18:00', close: '22:00' },
    };
    expect(transferPolicy(evening, hours, MON_NOON)).toEqual({
      transfer: false,
      reason: 'after_hours',
    });
    expect(transferPolicy(evening, hours, SUN_NOON).transfer).toBe(false);
    expect(transferPolicy(evening, hours, new Date('2026-09-13T14:00:00Z')).transfer).toBe(true); // Sun 19:30 IST
  });

  it('hours: open inclusive, close exclusive, in the merchant zone', () => {
    expect(isWithinHours(hours, new Date('2026-09-14T04:30:00Z'))).toBe(true); // 10:00 IST
    expect(isWithinHours(hours, new Date('2026-09-14T04:29:59Z'))).toBe(false);
    expect(isWithinHours(hours, new Date('2026-09-14T13:30:00Z'))).toBe(false); // 19:00 IST
    expect(isWithinHours({ ...hours, zone: 'Not/AZone' }, MON_NOON)).toBe(false);
    expect(describeHours(hours)).toBe('Mon–Sat 10:00–19:00');
    expect(describeHours({ ...hours, days: [1, 2, 3, 4, 5, 6, 7] })).toBe('every day 10:00–19:00');
    expect(describeHours({ ...hours, days: [1, 3, 5] })).toBe('Mon, Wed, Fri 10:00–19:00');
  });
});

describe('spoken references', () => {
  it('normalises order names and pincodes the way callers say them', () => {
    expect(orderNameKey('#1001')).toBe('1001');
    expect(orderNameKey('Order SO-1001-A')).toBe('orderso1001a');
    expect(normalisePincode(' 110 001 ')).toBe('110001');
  });
});

describe('inbound constants', () => {
  it('pins the latency budgets, verification lock, token TTL and billing rounding', () => {
    expect(C.INBOUND_CONTEXT_BUDGET_MS).toBe(500);
    expect(C.INBOUND_TOOL_BUDGET_MS).toBe(700);
    expect(C.VERIFY_MAX_FAILURES).toBe(3);
    expect(C.CANCEL_TOKEN_TTL_SEC).toBe(300);
    expect(C.INBOUND_BILLING_ROUNDING_SEC).toBe(60);
    expect(C.LOOKUP_MAX_ORDERS).toBeLessThanOrEqual(5);
    expect(C.KNOWLEDGE_SNIPPET_MAX_CHARS).toBeLessThanOrEqual(1000);
  });

  it('inbound outcomes are never outcome-billed (invariant 11 unchanged)', () => {
    for (const o of ['resolved', 'ticket_created', 'abandoned', 'spam']) {
      expect(C.BILLABLE_OUTCOMES as readonly string[], o).not.toContain(o);
    }
  });
});
