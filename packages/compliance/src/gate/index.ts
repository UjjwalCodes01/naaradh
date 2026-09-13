import { addMinutes } from '@naaradh/shared';
import { DateTime } from 'luxon';
import {
  CLI_MIN_ANSWER_RATE_7D,
  DND_SCRUB_TRANSACTIONAL_DEFAULT,
  MAX_ATTEMPTS_LIFETIME,
  MAX_ATTEMPTS_PER_24H,
  MAX_DURATION_SEC_BY_USE_CASE,
  MIN_MINUTES_BETWEEN_ATTEMPTS,
  WINDOW_CLOSE_BUFFER_MINUTES,
} from '../constants.js';
import { consentRequirement, isSourceAcceptable } from '../consent.js';
import type { GateReason } from './reasons.js';
import type {
  AttemptStatus,
  ConcurrencyLease,
  GateDeps,
  GateFail,
  GateInput,
  GateResult,
  GateStepRecord,
  GateTrace,
  SuppressionHit,
} from './types.js';
import { closesAt, isOpen, nextOpen, windowFor } from './windows.js';

/**
 * THE gate (CLAUDE.md invariant 1, AGENTS §5.2). Twelve ordered checks; the first failure
 * wins; every check performed is recorded in the trace that becomes `call_intents.gate_trace`.
 *
 * Nothing here dials. A pass returns everything the dispatcher needs — engine, CLI, script,
 * AMD mode, max duration, the dial deadline, and a held concurrency lease — and the
 * dispatcher's job is to use exactly that or release the lease.
 */
export async function gateIntent(input: GateInput, deps: GateDeps): Promise<GateResult> {
  const { tenant, contact, intent, now } = input;
  const steps: GateStepRecord[] = [];
  // Mutable holder rather than `let`s: assignments happen inside step closures, which TS's
  // control-flow narrowing does not see.
  const held: { engine: string | null; lease: ConcurrencyLease | null } = {
    engine: null,
    lease: null,
  };

  const fail = async (reason: GateReason, retryAt: Date | null = null): Promise<GateFail> => {
    if (held.lease !== null) await held.lease.release();
    return { ok: false, reason, retryAt, trace: trace() };
  };
  const trace = (): GateTrace => ({ at: now.toISOString(), engine: held.engine, steps });

  type StepOutcome =
    | { ok: true; detail?: GateStepRecord['detail'] }
    | { ok: false; reason: GateReason; retryAt?: Date | null; detail?: GateStepRecord['detail'] };

  async function step(
    n: number,
    name: string,
    run: () => Promise<StepOutcome> | StepOutcome,
  ): Promise<StepOutcome> {
    const started = performance.now();
    const out = await run();
    const record: GateStepRecord = {
      step: n,
      name,
      ok: out.ok,
      ms: Math.round((performance.now() - started) * 100) / 100,
      ...(out.detail === undefined ? {} : { detail: out.detail }),
      ...(out.ok ? {} : { reason: out.reason }),
    };
    steps.push(record);
    return out;
  }

  // ---- 0. sanity + engine selection -------------------------------------------------------
  const s0 = await step(0, 'intent+engine', async () => {
    if (now < intent.notBefore)
      return { ok: false, reason: 'intent:too_early', retryAt: intent.notBefore };
    if (intent.purpose !== 'transactional' && now > intent.notAfter)
      return { ok: false, reason: 'intent:expired' };

    const primary = tenant.engineOverride ?? deps.engines.defaultFor(intent.recipientRegion);
    if (primary === null) return { ok: false, reason: 'engine:unroutable' };

    if (await deps.engines.isCircuitOpen(primary)) {
      const secondary = tenant.multiEngineOk
        ? deps.engines.secondaryFor(intent.recipientRegion)
        : null;
      if (
        secondary !== null &&
        secondary !== primary &&
        !(await deps.engines.isCircuitOpen(secondary))
      ) {
        held.engine = secondary;
        return { ok: true, detail: { engine: secondary, failover_from: primary } };
      }
      return {
        ok: false,
        reason: 'engine:circuit_open',
        retryAt: addMinutes(now, 1),
        detail: { engine: primary },
      };
    }
    held.engine = primary;
    return { ok: true, detail: { engine: primary } };
  });
  if (!s0.ok || held.engine === null)
    return fail(s0.ok ? 'engine:unroutable' : s0.reason, s0.ok ? null : (s0.retryAt ?? null));
  const selectedEngine = held.engine;

  // ---- 1. tenant active && billing ok (E-50, E-61, E-73) -------------------------------------
  const s1 = await step(1, 'tenant+billing', () => {
    switch (tenant.status) {
      case 'active':
        break;
      case 'pending_review':
        if (intent.purpose === 'promotional') {
          return {
            ok: false,
            reason: 'tenant:pending_review_promotional',
            retryAt: tenant.reviewUntil,
          };
        }
        break;
      case 'paused':
      case 'suspended':
      case 'uninstalled':
        return { ok: false, reason: 'tenant:inactive', detail: { status: tenant.status } };
    }
    switch (tenant.billingStatus) {
      case 'active':
        return { ok: true, detail: { status: tenant.status, billing: 'active' } };
      case 'none':
        return { ok: false, reason: 'billing:not_set_up' };
      case 'frozen':
        if (tenant.billingGraceUntil !== null && now < tenant.billingGraceUntil) {
          return {
            ok: true,
            detail: {
              billing: 'frozen_in_grace',
              grace_until: tenant.billingGraceUntil.toISOString(),
            },
          };
        }
        return { ok: false, reason: 'billing:frozen' };
      case 'capped':
        return { ok: false, reason: 'billing:capped' };
      case 'cancelled':
        return { ok: false, reason: 'billing:cancelled' };
    }
  });
  if (!s1.ok) return fail(s1.reason, s1.retryAt ?? null);

  // ---- 2. kill switches: global → engine → tenant → campaign (invariant 12) -----------------
  const s2 = await step(2, 'kill_switches', async () => {
    const checks: readonly [
      GateReason,
      'global' | 'engine' | 'tenant' | 'campaign',
      string | null,
    ][] = [
      ['kill:global', 'global', '*'],
      ['kill:engine', 'engine', selectedEngine],
      ['kill:tenant', 'tenant', tenant.id],
      ['kill:campaign', 'campaign', intent.campaignId],
    ];
    for (const [reason, scope, key] of checks) {
      if (key === null) continue;
      if (await deps.killSwitches.isActive(scope, key)) {
        return { ok: false, reason, retryAt: addMinutes(now, 5), detail: { scope, key } };
      }
    }
    return { ok: true };
  });
  if (!s2.ok) return fail(s2.reason, s2.retryAt ?? null);

  // ---- 3. spend caps (E-32) ----------------------------------------------------------------
  const s3 = await step(3, 'spend_caps', async () => {
    if (tenant.spendCapDailyPaise !== null) {
      const spent = await deps.spend.tenantSpentToday(tenant.id);
      if (spent.minor >= tenant.spendCapDailyPaise) {
        return {
          ok: false,
          reason: 'cap:tenant_daily',
          retryAt: nextUtcDay(now),
          detail: { spent: spent.minor, cap: tenant.spendCapDailyPaise },
        };
      }
    }
    if (tenant.spendCapMonthlyPaise !== null) {
      const spent = await deps.spend.tenantSpentThisMonth(tenant.id);
      if (spent.minor >= tenant.spendCapMonthlyPaise) {
        return {
          ok: false,
          reason: 'cap:tenant_monthly',
          retryAt: nextUtcMonth(now),
          detail: { spent: spent.minor, cap: tenant.spendCapMonthlyPaise },
        };
      }
    }
    const engineCap = deps.spend.engineDailyCap(selectedEngine);
    if (engineCap !== null) {
      const spent = await deps.spend.engineSpentToday(selectedEngine);
      if (spent.minor >= engineCap.minor)
        return { ok: false, reason: 'cap:engine_daily', retryAt: nextUtcDay(now) };
    }
    const globalCap = deps.spend.globalDailyCap();
    if (globalCap !== null) {
      const spent = await deps.spend.globalSpentToday();
      if (spent.minor >= globalCap.minor)
        return { ok: false, reason: 'cap:global_daily', retryAt: nextUtcDay(now) };
    }
    return { ok: true };
  });
  if (!s3.ok) return fail(s3.reason, s3.retryAt ?? null);

  // ---- 4. number validity + contact flags (E-26, E-27, E-43, E-46) --------------------------
  const s4 = await step(4, 'number', async () => {
    if (!contact.hasPhone) return { ok: false, reason: 'number:missing' };
    if (contact.erasedAt !== null) return { ok: false, reason: 'contact:erased' };
    if (contact.skip) return { ok: false, reason: 'contact:skip' };
    // Structural validity (E.164, Indian mobile regex, premium/short/emergency) was enforced
    // at ingestion by normalizePhone(); the gate has no plaintext to re-check and records that.
    if (intent.recipientRegion === 'IN') {
      if (contact.phoneType === 'landline') return { ok: false, reason: 'number:landline' };
      if (contact.phoneType === 'unknown') {
        const strict = await deps.flags.get<boolean>(
          tenant.id,
          'number.reject_unknown_type_in',
          false,
        );
        if (strict)
          return { ok: false, reason: 'number:type_unknown', retryAt: addMinutes(now, 30) };
        return { ok: true, detail: { phone_type: 'unknown', policy: 'allow' } };
      }
    }
    return { ok: true, detail: { phone_type: contact.phoneType } };
  });
  if (!s4.ok) return fail(s4.reason, s4.retryAt ?? null);

  // ---- 5. suppressions (invariant 6, E-03, E-11, E-26) -------------------------------------
  const s5 = await step(5, 'suppressions', async () => {
    const hits = await deps.suppressions.findActive(tenant.id, intent.phoneHash, now);
    const applicable = hits.filter((h) => appliesTo(h, intent.purpose, intent.externalRef));
    const global = applicable.find((h) => h.scope === 'global');
    const chosen = global ?? applicable[0];
    if (chosen === undefined) return { ok: true, detail: { checked: hits.length } };
    const retryAt = chosen.until !== null && chosen.until < intent.notAfter ? chosen.until : null;
    return {
      ok: false,
      reason: chosen.scope === 'global' ? 'suppression:global' : 'suppression:tenant',
      retryAt,
      detail: { suppression_id: chosen.id, reason: chosen.reason, purpose: chosen.purpose },
    };
  });
  if (!s5.ok) return fail(s5.reason, s5.retryAt ?? null);

  // ---- 6. consent (invariants 4 & 5, E-01, E-02, E-06, E-07, E-08, E-71, E-73) --------------
  const s6 = await step(6, 'consent', async () => {
    if (intent.purpose === 'transactional' && now > intent.notAfter) {
      return {
        ok: false,
        reason: 'window:transactional_expired',
        detail: { not_after: intent.notAfter.toISOString() },
      };
    }
    const requirement = consentRequirement(intent.recipientRegion, intent.purpose);
    if (!requirement.required)
      return { ok: true, detail: { basis: 'transactional_within_window' } };

    const grants = await deps.consents.findGrants(tenant.id, intent.phoneHash, [
      intent.purpose,
      'all',
    ]);
    const acceptable = grants.filter((g) =>
      isSourceAcceptable(intent.recipientRegion, intent.purpose, g.source),
    );
    const live = acceptable.filter((g) => g.expiresAt === null || g.expiresAt > now);
    if (live.length === 0) {
      if (acceptable.length > 0)
        return { ok: false, reason: 'consent:expired', detail: { grants: grants.length } };
      if (grants.length > 0)
        return {
          ok: false,
          reason: 'consent:source_insufficient',
          detail: { grants: grants.length },
        };
      return { ok: false, reason: 'consent:missing' };
    }
    if (
      intent.purpose === 'promotional' &&
      intent.recipientRegion === 'IN' &&
      tenant.dltLinkedAt === null
    ) {
      return { ok: false, reason: 'consent:dlt_not_linked' };
    }
    const newest = live.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b));
    return {
      ok: true,
      detail: {
        consent_id: newest.id,
        source: newest.source,
        captured_at: newest.capturedAt.toISOString(),
      },
    };
  });
  if (!s6.ok) return fail(s6.reason, s6.retryAt ?? null);

  // ---- 7. calling window in the recipient's zone (invariants 2 & 3, E-01, E-02, E-51) ------
  const window = windowFor(intent.recipientRegion, contact.timezone);
  let dialDeadline: Date = intent.notAfter;
  const s7 = await step(7, 'window', () => {
    if (window === null) return { ok: false, reason: 'window:unknown_region' };
    const detail = { zones: window.zones.join(','), basis: window.basis };
    if (isOpen(now, window, WINDOW_CLOSE_BUFFER_MINUTES)) {
      const close = closesAt(now, window);
      if (close !== null) {
        const latestDial = addMinutes(close, -WINDOW_CLOSE_BUFFER_MINUTES);
        if (latestDial < dialDeadline) dialDeadline = latestDial;
      }
      return { ok: true, detail: { ...detail, dial_deadline: dialDeadline.toISOString() } };
    }
    if (intent.purpose === 'transactional')
      return { ok: false, reason: 'window:closed_transactional', detail };
    const reopen = nextOpen(now, window, WINDOW_CLOSE_BUFFER_MINUTES);
    return {
      ok: false,
      reason: 'window:closed',
      retryAt: reopen,
      detail: { ...detail, next_open: reopen.toISOString() },
    };
  });
  if (!s7.ok) return fail(s7.reason, s7.retryAt ?? null);

  // ---- 8. DND / NCPR (E-04, Q-02) ----------------------------------------------------------
  const s8 = await step(8, 'dnd', async () => {
    if (intent.purpose === 'promotional') {
      const result = await deps.dnd.scrub(intent.phoneHash, intent.recipientRegion, now);
      if (result === 'not_registered') return { ok: true, detail: { result } };
      if (result === 'registered') return { ok: false, reason: 'dnd:registered' };
      return { ok: false, reason: 'dnd:unknown', retryAt: addMinutes(now, 15) };
    }
    const scrubTransactional = await deps.flags.get<boolean>(
      tenant.id,
      'dnd.scrub_transactional',
      DND_SCRUB_TRANSACTIONAL_DEFAULT,
    );
    if (!scrubTransactional) return { ok: true, detail: { skipped: 'flag_off' } };
    const result = await deps.dnd.scrub(intent.phoneHash, intent.recipientRegion, now);
    if (result === 'registered') return { ok: false, reason: 'dnd:registered' };
    return { ok: true, detail: { result } };
  });
  if (!s8.ok) return fail(s8.reason, s8.retryAt ?? null);

  // ---- 9. attempt limits ---------------------------------------------------------------------
  const s9 = await step(9, 'attempts', async () => {
    const history = await deps.attempts.history(
      tenant.id,
      intent.phoneHash,
      intent.purpose,
      intent.externalRef,
    );
    const live = history.filter((a) => LIVE_STATUSES.has(a.status));
    if (live.length > 0) {
      return {
        ok: false,
        reason: 'attempts:too_soon',
        retryAt: addMinutes(now, MIN_MINUTES_BETWEEN_ATTEMPTS[intent.purpose]),
        detail: { live: live.length },
      };
    }
    const dialed = history.filter(
      (a) => CUSTOMER_FACING_STATUSES.has(a.status) && a.dispatchedAt !== null,
    );
    if (dialed.length >= MAX_ATTEMPTS_LIFETIME)
      return { ok: false, reason: 'attempts:lifetime', detail: { dialed: dialed.length } };

    const since = addMinutes(now, -24 * 60);
    const last24 = dialed
      .filter((a) => (a.dispatchedAt as Date) >= since)
      .sort((a, b) => (a.dispatchedAt as Date).getTime() - (b.dispatchedAt as Date).getTime());
    if (last24.length >= MAX_ATTEMPTS_PER_24H) {
      return {
        ok: false,
        reason: 'attempts:daily',
        retryAt: addMinutes(last24[0]?.dispatchedAt as Date, 24 * 60),
        detail: { last24: last24.length },
      };
    }
    const last = dialed.reduce<Date | null>(
      (m, a) => (m === null || (a.dispatchedAt as Date) > m ? (a.dispatchedAt as Date) : m),
      null,
    );
    if (last !== null) {
      const earliest = addMinutes(last, MIN_MINUTES_BETWEEN_ATTEMPTS[intent.purpose]);
      if (now < earliest)
        return {
          ok: false,
          reason: 'attempts:too_soon',
          retryAt: earliest,
          detail: { last: last.toISOString() },
        };
    }
    return { ok: true, detail: { dialed: dialed.length, last24: last24.length } };
  });
  if (!s9.ok) return fail(s9.reason, s9.retryAt ?? null);

  // ---- 10. concurrency (E-29) — the lease is HELD from here on ---------------------------------
  const s10 = await step(10, 'concurrency', async () => {
    const r = await deps.concurrency.tryAcquire(
      tenant.id,
      tenant.maxConcurrency,
      selectedEngine,
      deps.engines.maxConcurrency(selectedEngine),
    );
    if (!r.ok)
      return {
        ok: false,
        reason: r.which === 'tenant' ? 'concurrency:tenant' : 'concurrency:engine',
        retryAt: addMinutes(now, 0.5),
      };
    held.lease = r.lease;
    return { ok: true };
  });
  if (!s10.ok || held.lease === null)
    return fail(s10.ok ? 'concurrency:engine' : s10.reason, s10.ok ? null : (s10.retryAt ?? null));
  const lease = held.lease;

  // ---- 11. CLI selection (E-28, Q-01) -----------------------------------------------------------
  const candidates = await deps.numbers.candidates(
    tenant.id,
    intent.recipientRegion,
    selectedEngine,
  );
  const eligible = candidates.filter(
    (n) =>
      n.region === intent.recipientRegion &&
      n.engine === selectedEngine &&
      n.status === 'active' &&
      n.purposeAllowed.includes(intent.purpose) &&
      (n.answerRate7d === null || n.answerRate7d >= CLI_MIN_ANSWER_RATE_7D),
  );
  const cli = eligible[0];
  const s11 = await step(11, 'cli', () =>
    cli === undefined
      ? {
          ok: false,
          reason: 'cli:none_available',
          retryAt: addMinutes(now, 15),
          detail: { candidates: candidates.length },
        }
      : {
          ok: true,
          detail: { number_id: cli.id, owned: cli.ownedByTenant, candidates: candidates.length },
        },
  );
  if (!s11.ok || cli === undefined) return fail('cli:none_available', addMinutes(now, 15));

  // ---- 12. approved script with validated disclosure (invariant 7, E-09) ------------------------
  const script = await deps.scripts.approved(tenant.id, intent.useCaseId, intent.locale);
  const s12 = await step(12, 'script', () =>
    script === null
      ? { ok: false, reason: 'script:none_approved', detail: { locale: intent.locale } }
      : { ok: true, detail: { script_id: script.id, version: script.version } },
  );
  if (!s12.ok || script === null) return fail('script:none_approved');

  return {
    ok: true,
    engine: selectedEngine,
    cli,
    script,
    amdMode:
      intent.purpose === 'promotional' ? tenant.amdModePromotional : tenant.amdModeTransactional,
    maxDurationSec: MAX_DURATION_SEC_BY_USE_CASE[intent.useCase],
    dialDeadline,
    lease,
    trace: trace(),
  };
}

function appliesTo(
  hit: SuppressionHit,
  purpose: GateInput['intent']['purpose'],
  externalRef: string,
): boolean {
  const purposeMatches = hit.purpose === 'all' || hit.purpose === purpose;
  const refMatches = hit.externalRef === null || hit.externalRef === externalRef;
  return purposeMatches && refMatches;
}

/** Attempts that are currently on the wire: never start a second one. */
const LIVE_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  'DISPATCHING',
  'UNCERTAIN',
  'DIALING',
  'RINGING',
  'IN_CONVERSATION',
  'TRANSFERRING',
]);

/** Attempts the customer could have noticed — the ones that count toward the limits. */
const CUSTOMER_FACING_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  'DIALING',
  'RINGING',
  'IN_CONVERSATION',
  'TRANSFERRING',
  'ENDED',
  'NO_ANSWER',
  'BUSY',
  'AMD_HANGUP',
  'AMD_MESSAGE_LEFT',
]);

/** Spend counters roll over on UTC calendar boundaries (adapters/redis.ts keys by UTC date). */
function nextUtcDay(now: Date): Date {
  return DateTime.fromJSDate(now, { zone: 'utc' }).plus({ days: 1 }).startOf('day').toJSDate();
}

function nextUtcMonth(now: Date): Date {
  return DateTime.fromJSDate(now, { zone: 'utc' }).plus({ months: 1 }).startOf('month').toJSDate();
}
