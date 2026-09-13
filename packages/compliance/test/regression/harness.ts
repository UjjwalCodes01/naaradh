import { addMinutes, money, paise } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { createHash } from 'node:crypto';
import type {
  AttemptSummary,
  ConsentHit,
  ContactSnapshot,
  GateDeps,
  GateInput,
  IntentSnapshot,
  NumberCandidate,
  ScriptRef,
  SuppressionHit,
  TenantSnapshot,
} from '../../src/gate/types.js';

/**
 * In-memory fakes for the gate ports, plus builders for a "happy" Indian COD intent. Every
 * regression test starts from `happyInput()` and `happyDeps()` and breaks exactly one thing,
 * so a failure names the rule that regressed.
 */

export const h = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 2026-09-14 is a Monday. 12:00 IST = 06:30 UTC. */
export const NOON_IST = new Date('2026-09-14T06:30:00Z');

export function istInstant(date: string, hm: string): Date {
  // IST is UTC+05:30 with no DST.
  const [hh, mm, ss = '00'] = hm.split(':');
  const local = new Date(`${date}T${hh as string}:${mm as string}:${ss}Z`);
  return new Date(local.getTime() - (5 * 60 + 30) * 60_000);
}

export const TENANT_ID = 'ten_01TESTTENANTAAAAAAAAAAAAAA';

export function tenant(overrides: Partial<TenantSnapshot> = {}): TenantSnapshot {
  return {
    id: TENANT_ID,
    status: 'active',
    reviewUntil: null,
    dltLinkedAt: new Date('2026-09-01T00:00:00Z'),
    billingStatus: 'active',
    billingGraceUntil: null,
    currency: 'INR',
    spendCapDailyPaise: 2_000_00,
    spendCapMonthlyPaise: 40_000_00,
    maxConcurrency: 3,
    engineOverride: null,
    multiEngineOk: false,
    amdModeTransactional: 'continue',
    amdModePromotional: 'hangup',
    ...overrides,
  };
}

export function contact(overrides: Partial<ContactSnapshot> = {}): ContactSnapshot {
  return {
    id: 'cnt_01TESTCONTACTAAAAAAAAAAAAA',
    hasPhone: true,
    phoneType: 'mobile',
    phoneTypeCheckedAt: new Date('2026-09-10T00:00:00Z'),
    timezone: null,
    skip: false,
    erasedAt: null,
    ...overrides,
  };
}

export function codIntent(eventTs: Date, overrides: Partial<IntentSnapshot> = {}): IntentSnapshot {
  return {
    id: 'int_01TESTINTENTAAAAAAAAAAAAAA',
    tenantId: TENANT_ID,
    useCaseId: 'usc_01TESTUSECASEAAAAAAAAAAAAA',
    useCase: 'cod_confirm',
    purpose: 'transactional',
    phoneHash: h(FAKE_IN.customer),
    recipientRegion: 'IN',
    eventTs,
    notBefore: addMinutes(eventTs, 2),
    notAfter: addMinutes(eventTs, 30),
    attemptsCount: 0,
    externalRef: 'order-1001',
    locale: 'hi-IN',
    campaignId: null,
    ...overrides,
  };
}

export function cartIntent(eventTs: Date, overrides: Partial<IntentSnapshot> = {}): IntentSnapshot {
  return codIntent(eventTs, {
    useCase: 'abandoned_cart',
    purpose: 'promotional',
    notBefore: addMinutes(eventTs, 45),
    notAfter: addMinutes(eventTs, 24 * 60),
    externalRef: 'checkout-2002',
    ...overrides,
  });
}

export function leadIntent(eventTs: Date, overrides: Partial<IntentSnapshot> = {}): IntentSnapshot {
  return codIntent(eventTs, {
    useCase: 'lead_callback',
    purpose: 'service',
    notBefore: addMinutes(eventTs, 1),
    notAfter: addMinutes(eventTs, 120),
    externalRef: 'lead-3003',
    locale: 'en-IN',
    ...overrides,
  });
}

/** Noon IST, order placed 5 minutes ago: inside the window, inside the 30-minute envelope. */
export function happyInput(overrides: Partial<GateInput> = {}): GateInput {
  const now = NOON_IST;
  return {
    tenant: tenant(),
    contact: contact(),
    intent: codIntent(addMinutes(now, -5)),
    now,
    ...overrides,
  };
}

export interface FakeState {
  circuitOpen: Set<string>;
  killSwitches: Set<string>; // `${scope}:${key}`
  spent: { tenantDay: number; tenantMonth: number; engineDay: number; globalDay: number };
  engineCapPaise: number | null;
  globalCapPaise: number | null;
  suppressions: SuppressionHit[];
  consents: ConsentHit[];
  flags: Map<string, unknown>;
  dnd: 'registered' | 'not_registered' | 'unknown';
  dndCalls: number;
  attempts: AttemptSummary[];
  concurrency: { tenantInUse: number; engineInUse: number; engineMax: number };
  released: number;
  numbers: NumberCandidate[];
  scripts: Map<string, ScriptRef>; // `${useCaseId}:${locale}`
}

export function poolNumber(overrides: Partial<NumberCandidate> = {}): NumberCandidate {
  return {
    id: 'num_01TESTNUMBERAAAAAAAAAAAAAA',
    e164: FAKE_IN.merchant,
    region: 'IN',
    engine: 'simulator',
    purposeAllowed: ['transactional', 'service', 'promotional'],
    status: 'active',
    answerRate7d: 0.41,
    ownedByTenant: false,
    ...overrides,
  };
}

export function approvedScript(overrides: Partial<ScriptRef> = {}): ScriptRef {
  return {
    id: 'scr_01TESTSCRIPTAAAAAAAAAAAAAA',
    version: 1,
    locale: 'hi-IN',
    dltTemplateId: null,
    ...overrides,
  };
}

export function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  const scripts = new Map<string, ScriptRef>();
  scripts.set('usc_01TESTUSECASEAAAAAAAAAAAAA:hi-IN', approvedScript());
  scripts.set('usc_01TESTUSECASEAAAAAAAAAAAAA:en-IN', approvedScript({ locale: 'en-IN' }));
  return {
    circuitOpen: new Set(),
    killSwitches: new Set(),
    spent: { tenantDay: 0, tenantMonth: 0, engineDay: 0, globalDay: 0 },
    engineCapPaise: 50_000_00,
    globalCapPaise: 200_000_00,
    suppressions: [],
    consents: [],
    flags: new Map(),
    dnd: 'not_registered',
    dndCalls: 0,
    attempts: [],
    concurrency: { tenantInUse: 0, engineInUse: 0, engineMax: 20 },
    released: 0,
    numbers: [poolNumber()],
    scripts,
    ...overrides,
  };
}

export function fakeDeps(state: FakeState): GateDeps {
  return {
    engines: {
      defaultFor: (region) =>
        region === 'IN'
          ? 'simulator'
          : region === 'US' || region === 'GB' || region === 'DE'
            ? 'simulator-us'
            : null,
      secondaryFor: (region) => (region === 'IN' ? 'simulator-secondary' : null),
      isCircuitOpen: async (engine) => state.circuitOpen.has(engine),
      maxConcurrency: () => state.concurrency.engineMax,
    },
    killSwitches: { isActive: async (scope, key) => state.killSwitches.has(`${scope}:${key}`) },
    spend: {
      tenantSpentToday: async () => paise(state.spent.tenantDay),
      tenantSpentThisMonth: async () => paise(state.spent.tenantMonth),
      engineSpentToday: async () => paise(state.spent.engineDay),
      globalSpentToday: async () => paise(state.spent.globalDay),
      engineDailyCap: () =>
        state.engineCapPaise === null ? null : money(state.engineCapPaise, 'INR'),
      globalDailyCap: () =>
        state.globalCapPaise === null ? null : money(state.globalCapPaise, 'INR'),
    },
    suppressions: {
      findActive: async (_tenantId, phoneHash, now) =>
        state.suppressions
          .filter((s) => s.until === null || s.until > now)
          .filter(() => phoneHash.length === 64),
    },
    consents: {
      findGrants: async (_tenantId, _hash, purposes) =>
        state.consents.filter((c) => purposes.includes(c.purpose)),
    },
    flags: {
      get: async <T>(_tenantId: string, key: string, fallback: T): Promise<T> =>
        state.flags.has(key) ? (state.flags.get(key) as T) : fallback,
    },
    dnd: {
      scrub: async () => {
        state.dndCalls += 1;
        return state.dnd;
      },
    },
    attempts: { history: async () => state.attempts },
    concurrency: {
      tryAcquire: async (_tenantId, tenantMax, _engine, engineMax) => {
        if (state.concurrency.tenantInUse >= tenantMax) return { ok: false, which: 'tenant' };
        if (state.concurrency.engineInUse >= engineMax) return { ok: false, which: 'engine' };
        state.concurrency.tenantInUse += 1;
        state.concurrency.engineInUse += 1;
        return {
          ok: true,
          lease: {
            tenantSlot: 't',
            engineSlot: 'e',
            release: async () => {
              state.concurrency.tenantInUse -= 1;
              state.concurrency.engineInUse -= 1;
              state.released += 1;
            },
          },
        };
      },
    },
    numbers: { candidates: async () => state.numbers },
    scripts: {
      approved: async (_tenantId, useCaseId, locale) =>
        state.scripts.get(`${useCaseId}:${locale}`) ?? null,
    },
  };
}

export function suppression(overrides: Partial<SuppressionHit> = {}): SuppressionHit {
  return {
    id: 'sup_01TESTSUPPRESSIONAAAAAAAAA',
    scope: 'tenant',
    purpose: 'all',
    reason: 'opt_out',
    externalRef: null,
    until: null,
    ...overrides,
  };
}

export function consent(overrides: Partial<ConsentHit> = {}): ConsentHit {
  return {
    id: 'con_01TESTCONSENTAAAAAAAAAAAAA',
    purpose: 'promotional',
    source: 'checkout',
    capturedAt: addMinutes(NOON_IST, -60),
    expiresAt: addMinutes(NOON_IST, 6 * 24 * 60),
    ...overrides,
  };
}

export function attempt(overrides: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    id: 'att_01TESTATTEMPTAAAAAAAAAAAAA',
    status: 'NO_ANSWER',
    dispatchedAt: addMinutes(NOON_IST, -60),
    endedAt: addMinutes(NOON_IST, -59),
    ...overrides,
  };
}
