import { DateTime } from 'luxon';
import { z } from 'zod';

/**
 * The rules behind the voice agent's tools (AGENTS §5.8–§5.9), as pure functions so the
 * regression suite can pin them. voice calls these and does exactly what they say.
 */

export type Identity = 'none' | 'caller_id' | 'knowledge';

export const IDENTITY_RANK: Readonly<Record<Identity, number>> = {
  none: 0,
  caller_id: 1,
  knowledge: 2,
};

export function maxIdentity(a: Identity, b: Identity): Identity {
  return IDENTITY_RANK[a] >= IDENTITY_RANK[b] ? a : b;
}

export interface OrderFacts {
  readonly id: string;
  readonly phoneHash: string | null;
  readonly paymentKind: 'cod' | 'prepaid' | 'unknown';
  readonly fulfillmentStatus: string | null;
  readonly cancelledAt: Date | null;
}

export interface CallerState {
  readonly identity: Identity;
  /** Caller's phone hash; null when withheld. */
  readonly callerHash: string | null;
  /** Orders proven by verify_caller (knowledge) during this call. */
  readonly verifiedOrderIds: readonly string[];
}

/**
 * Invariant 17 / E-82: may the agent discuss this order with this caller? Only if the caller
 * rang from the order's phone, or proved order number + pincode for THIS order.
 */
export function canDiscussOrder(caller: CallerState, order: OrderFacts): boolean {
  if (caller.verifiedOrderIds.includes(order.id)) return true;
  return (
    caller.callerHash !== null && order.phoneHash !== null && caller.callerHash === order.phoneHash
  );
}

/** Fulfilment statuses after which a cancellation is a return, not a cancellation (E-85). */
const SHIPPED_STATUSES = new Set([
  'fulfilled',
  'partial',
  'shipped',
  'in_transit',
  'out_for_delivery',
  'delivered',
]);

export function isShipped(order: OrderFacts): boolean {
  return (
    order.fulfillmentStatus !== null && SHIPPED_STATUSES.has(order.fulfillmentStatus.toLowerCase())
  );
}

export type CancellationDecision =
  | { readonly kind: 'refuse'; readonly reason: 'not_verified' | 'already_cancelled' }
  | {
      readonly kind: 'ticket';
      readonly reason: 'agent_cancel_disabled' | 'shipped' | 'prepaid' | 'payment_unknown';
    }
  | { readonly kind: 'execute' };

/**
 * Invariant 14 / E-84 / E-85. Evaluated at BOTH steps of the two-step cancellation: at step 1
 * to decide what to tell the caller, and again at step 2 because the order may have shipped
 * in the minute between.
 */
export function cancellationPolicy(
  caller: CallerState,
  order: OrderFacts,
  agentCancelEnabled: boolean,
): CancellationDecision {
  if (!canDiscussOrder(caller, order)) return { kind: 'refuse', reason: 'not_verified' };
  if (order.cancelledAt !== null) return { kind: 'refuse', reason: 'already_cancelled' };
  if (isShipped(order)) return { kind: 'ticket', reason: 'shipped' };
  if (order.paymentKind === 'prepaid') return { kind: 'ticket', reason: 'prepaid' };
  if (order.paymentKind === 'unknown') return { kind: 'ticket', reason: 'payment_unknown' };
  if (!agentCancelEnabled) return { kind: 'ticket', reason: 'agent_cancel_disabled' };
  return { kind: 'execute' };
}

// ---------------------------------------------------------------------------
// Business hours (transfers, closed messages)
// ---------------------------------------------------------------------------

export const BusinessHours = z.object({
  zone: z.string().min(1),
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: z.array(z.number().int().min(1).max(7)).min(1),
  open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export type BusinessHours = z.infer<typeof BusinessHours>;

function hm(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(':');
  return { hour: Number(h), minute: Number(m) };
}

/** Open inclusive, close exclusive, in the hours' own zone (the merchant's). */
export function isWithinHours(hours: BusinessHours, at: Date): boolean {
  const local = DateTime.fromJSDate(at, { zone: hours.zone });
  if (!local.isValid) return false;
  if (!hours.days.includes(local.weekday)) return false;
  const open = local.set({ ...hm(hours.open), second: 0, millisecond: 0 });
  const close = local.set({ ...hm(hours.close), second: 0, millisecond: 0 });
  return local >= open && local < close;
}

/** "Mon–Sat 10:00–19:00" for the closed message and the transfer refusal. */
export function describeHours(hours: BusinessHours): string {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const sorted = [...new Set(hours.days)].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] ?? 0) + 1);
  const days =
    sorted.length === 7
      ? 'every day'
      : contiguous && sorted.length > 1
        ? `${names[(sorted[0] ?? 1) - 1] ?? ''}–${names[(sorted.at(-1) ?? 1) - 1] ?? ''}`
        : sorted.map((d) => names[d - 1]).join(', ');
  return `${days} ${hours.open}–${hours.close}`;
}

export type TransferDecision =
  | { readonly transfer: true; readonly targetId: string }
  | { readonly transfer: false; readonly reason: 'no_target' | 'not_verified' | 'after_hours' };

export interface TransferTargetFacts {
  readonly id: string;
  readonly active: boolean;
  readonly verifiedAt: Date | null;
  /** Target's own hours, falling back to the profile's. */
  readonly hours: BusinessHours | null;
}

/** Invariant 19 / E-86 / E-87. The caller never supplies a number; there is nothing to pass in for one. */
export function transferPolicy(
  target: TransferTargetFacts | null,
  profileHours: BusinessHours,
  at: Date,
): TransferDecision {
  if (target === null || !target.active) return { transfer: false, reason: 'no_target' };
  if (target.verifiedAt === null) return { transfer: false, reason: 'not_verified' };
  if (!isWithinHours(target.hours ?? profileHours, at))
    return { transfer: false, reason: 'after_hours' };
  return { transfer: true, targetId: target.id };
}

// ---------------------------------------------------------------------------
// Spoken order references ("one zero zero one", "#1001", "order 1001") → name_key
// ---------------------------------------------------------------------------

/** Lowercase alphanumerics only: "#1001" → "1001", "SO-1001-A" → "so1001a". */
export function orderNameKey(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-z]/g, '');
}

/** Pincode as spoken or typed → canonical 6 digits for India, else alphanumerics. */
export function normalisePincode(value: string): string {
  return value
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}
