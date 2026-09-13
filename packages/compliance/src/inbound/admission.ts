import { INBOUND_DEFAULT_MONTHLY_MINUTE_CAP } from '../constants.js';
import type { ConcurrencyLease, ConcurrencyPort, KillSwitchPort } from '../gate/types.js';

/**
 * Inbound admission (AGENTS §5.7, invariant 1). A customer dialled a merchant's number; this
 * decides whether the AI answers or the call falls back. Ordered, first failure wins, every
 * step recorded — the inbound counterpart of gateIntent(), and just as pure: the caller
 * supplies snapshots and ports, so the regression suite runs it with a fixed clock.
 *
 * What is deliberately NOT here: consent, DND, the 09:00–21:00 window. The customer called;
 * those rules exist to decide whether WE may disturb THEM.
 */

export type NumberStatus = 'warming' | 'active' | 'retired' | 'suspended';
export type TenantStatus = 'pending_review' | 'active' | 'paused' | 'suspended' | 'uninstalled';
export type BillingStatus = 'none' | 'active' | 'frozen' | 'capped' | 'cancelled';
export type ProfileStatus = 'draft' | 'active' | 'disabled';

export interface AdmissionNumber {
  readonly id: string;
  readonly tenantId: string | null;
  readonly inboundProfileId: string | null;
  readonly engine: string;
  readonly status: NumberStatus;
  readonly inboundEnabled: boolean;
}

export interface AdmissionTenant {
  readonly id: string;
  readonly status: TenantStatus;
  readonly billingStatus: BillingStatus;
  readonly billingGraceUntil: Date | null;
}

export interface AdmissionProfile {
  readonly id: string;
  readonly status: ProfileStatus;
  readonly maxConcurrent: number;
  readonly maxCallsPerCallerHour: number;
  readonly monthlyMinuteCap: number | null;
  readonly hasFallbackForward: boolean;
}

export interface AdmissionInput {
  readonly now: Date;
  readonly number: AdmissionNumber | null;
  readonly tenant: AdmissionTenant | null;
  readonly profile: AdmissionProfile | null;
  /** Null when the caller withheld their number (E-80) — they are admitted, but not rate-keyed. */
  readonly callerHash: string | null;
}

export interface AdmissionDeps {
  readonly killSwitches: KillSwitchPort;
  readonly concurrency: ConcurrencyPort;
  readonly minutesUsedThisMonth: (tenantId: string) => Promise<number>;
  /** Records this call and returns how many calls this caller made to this tenant in the last hour, including this one. */
  readonly callerCallsLastHour: (
    tenantId: string,
    callerHash: string,
    now: Date,
  ) => Promise<number>;
  readonly isEngineCircuitOpen: (engine: string) => Promise<boolean>;
  readonly engineMaxConcurrency: (engine: string) => number;
}

export const INBOUND_REASONS = {
  'inbound:number_unrouted': 'This number is not routed to an active agent.',
  'inbound:profile_inactive': 'The agent profile for this number is not active.',
  'inbound:tenant_inactive': 'The merchant account is paused, suspended or uninstalled.',
  'inbound:billing': 'Billing for the merchant is not active.',
  'inbound:kill': 'Inbound answering is switched off (kill switch).',
  'inbound:minute_cap': 'The monthly inbound minute cap is reached.',
  'inbound:concurrency': 'All agent lines for this merchant are busy.',
  'inbound:abuse': 'This caller has called too many times in the last hour.',
  'inbound:engine_down': 'The voice engine is unavailable.',
} as const;

export type InboundReason = keyof typeof INBOUND_REASONS;

/**
 * What the caller hears when the agent cannot answer (E-92 — never dead air):
 *   forward   the merchant's own number takes the call
 *   closed    a spoken closed/unavailable message with hours
 *   abuse     a brief message, then hang up (never forwarded to the merchant's staff)
 */
export type Fallback = 'forward' | 'closed' | 'abuse';

export interface AdmissionStep {
  readonly step: number;
  readonly name: string;
  readonly ok: boolean;
  readonly reason?: InboundReason;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export type AdmissionResult =
  | {
      readonly ok: true;
      readonly tenantId: string;
      readonly profileId: string;
      readonly numberId: string;
      readonly engine: string;
      readonly lease: ConcurrencyLease;
      readonly trace: readonly AdmissionStep[];
    }
  | {
      readonly ok: false;
      readonly reason: InboundReason;
      readonly fallback: Fallback;
      readonly tenantId: string | null;
      readonly profileId: string | null;
      readonly trace: readonly AdmissionStep[];
    };

/** Concurrency keys for inbound are namespaced so they never share a tenant's outbound slots. */
export function inboundConcurrencyKey(tenantId: string): string {
  return `inbound:${tenantId}`;
}

export async function admitInbound(
  input: AdmissionInput,
  deps: AdmissionDeps,
): Promise<AdmissionResult> {
  const trace: AdmissionStep[] = [];
  const pass = (step: number, name: string, detail?: AdmissionStep['detail']) => {
    trace.push({ step, name, ok: true, ...(detail === undefined ? {} : { detail }) });
  };
  const refuse = (
    step: number,
    name: string,
    reason: InboundReason,
    fallback: Fallback,
    detail?: AdmissionStep['detail'],
  ): AdmissionResult => {
    trace.push({ step, name, ok: false, reason, ...(detail === undefined ? {} : { detail }) });
    return {
      ok: false,
      reason,
      // Forward only when the merchant gave a number; an unrouted number has no merchant to forward to.
      fallback:
        fallback === 'forward' && input.profile?.hasFallbackForward !== true ? 'closed' : fallback,
      tenantId: input.tenant?.id ?? input.number?.tenantId ?? null,
      profileId: input.profile?.id ?? null,
      trace,
    };
  };

  // 1. number → profile (invariant 16)
  const n = input.number;
  if (
    n === null ||
    n.tenantId === null ||
    n.inboundProfileId === null ||
    !n.inboundEnabled ||
    n.status !== 'active'
  ) {
    return refuse(1, 'number', 'inbound:number_unrouted', 'closed', { known: n !== null });
  }
  const p = input.profile;
  if (p === null || p.id !== n.inboundProfileId || p.status !== 'active') {
    return refuse(1, 'number', 'inbound:profile_inactive', 'closed');
  }
  pass(1, 'number', { number_id: n.id, profile_id: p.id });

  // 2. tenant + billing
  const t = input.tenant;
  if (
    t === null ||
    t.id !== n.tenantId ||
    (t.status !== 'active' && t.status !== 'pending_review')
  ) {
    return refuse(2, 'tenant', 'inbound:tenant_inactive', 'forward', { status: t?.status ?? null });
  }
  const inGrace =
    t.billingStatus === 'frozen' && t.billingGraceUntil !== null && input.now < t.billingGraceUntil;
  if (t.billingStatus !== 'active' && !inGrace) {
    return refuse(2, 'tenant', 'inbound:billing', 'forward', { billing: t.billingStatus });
  }
  pass(2, 'tenant', { status: t.status, billing: inGrace ? 'frozen_in_grace' : t.billingStatus });

  // 3. kill switches: inbound:* then inbound:<tenant>. A GLOBAL OUTBOUND kill does not stop answering.
  if (await deps.killSwitches.isActive('inbound', '*'))
    return refuse(3, 'kill', 'inbound:kill', 'forward', { key: '*' });
  if (await deps.killSwitches.isActive('inbound', t.id))
    return refuse(3, 'kill', 'inbound:kill', 'forward', { key: 'tenant' });
  pass(3, 'kill');

  // 4. monthly minutes (E-92)
  const cap = p.monthlyMinuteCap ?? INBOUND_DEFAULT_MONTHLY_MINUTE_CAP;
  const used = await deps.minutesUsedThisMonth(t.id);
  if (used >= cap) return refuse(4, 'minutes', 'inbound:minute_cap', 'forward', { used, cap });
  pass(4, 'minutes', { used, cap });

  // 6 before 5: the abuse counter must record the call even when lines are busy, and an
  // abusive caller should not consume a concurrency slot.
  if (input.callerHash !== null) {
    const calls = await deps.callerCallsLastHour(t.id, input.callerHash, input.now);
    if (calls > p.maxCallsPerCallerHour) {
      return refuse(6, 'abuse', 'inbound:abuse', 'abuse', {
        calls,
        limit: p.maxCallsPerCallerHour,
      });
    }
    pass(6, 'abuse', { calls, limit: p.maxCallsPerCallerHour });
  } else {
    pass(6, 'abuse', { withheld: true });
  }

  // 7. engine health (before taking a slot)
  if (await deps.isEngineCircuitOpen(n.engine))
    return refuse(7, 'engine', 'inbound:engine_down', 'forward', { engine: n.engine });
  pass(7, 'engine', { engine: n.engine });

  // 5. concurrency — last, because a pass HOLDS the slot until the call ends.
  const slot = await deps.concurrency.tryAcquire(
    inboundConcurrencyKey(t.id),
    p.maxConcurrent,
    n.engine,
    deps.engineMaxConcurrency(n.engine),
  );
  if (!slot.ok)
    return refuse(5, 'concurrency', 'inbound:concurrency', 'forward', { which: slot.which });
  pass(5, 'concurrency');

  return {
    ok: true,
    tenantId: t.id,
    profileId: p.id,
    numberId: n.id,
    engine: n.engine,
    lease: slot.lease,
    trace,
  };
}
