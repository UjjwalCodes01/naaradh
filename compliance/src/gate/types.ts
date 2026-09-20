import type { schema } from '@naaradh/db';
import type { Money } from '@naaradh/shared';
import type { GateReason } from './reasons.js';

/**
 * The gate is a pure function over snapshots + ports. Nothing in here touches Postgres or
 * Redis directly; adapters in ../adapters implement the ports. That is what lets the
 * regression suite run every edge case with a fixed clock and no containers.
 */

type EnumValues<T extends { enumValues: readonly string[] }> = T['enumValues'][number];

export type TenantStatus = EnumValues<typeof schema.tenantStatus>;
export type BillingStatus = EnumValues<typeof schema.billingStatus>;
export type Purpose = EnumValues<typeof schema.purpose>;
export type PurposeScope = EnumValues<typeof schema.purposeScope>;
export type UseCaseKind = EnumValues<typeof schema.useCaseKind>;
export type AmdMode = EnumValues<typeof schema.amdMode>;
export type ConsentSource = EnumValues<typeof schema.consentSource>;
export type SuppressionReason = EnumValues<typeof schema.suppressionReason>;
export type PhoneType = EnumValues<typeof schema.phoneType>;
export type AttemptStatus = EnumValues<typeof schema.attemptStatus>;
export type DndResult = EnumValues<typeof schema.dndResult>;
export type KillSwitchScope = EnumValues<typeof schema.killSwitchScope>;

export interface TenantSnapshot {
  readonly id: string;
  readonly status: TenantStatus;
  /** ADR-0012: where this tenant's data lives. A deployment serves exactly one region. */
  readonly dataRegion?: string;
  readonly reviewUntil: Date | null;
  readonly dltLinkedAt: Date | null;
  /** ADR-0010 §5: promotional calling paused after a complaint on a promotional call. */
  readonly promotionalPausedAt?: Date | null;
  readonly billingStatus: BillingStatus;
  readonly billingGraceUntil: Date | null;
  readonly currency: string;
  readonly spendCapDailyPaise: number | null;
  readonly spendCapMonthlyPaise: number | null;
  readonly maxConcurrency: number;
  readonly engineOverride: string | null;
  readonly multiEngineOk: boolean;
  readonly amdModeTransactional: AmdMode;
  readonly amdModePromotional: AmdMode;
}

export interface ContactSnapshot {
  readonly id: string;
  /** False when the source had no phone (E-43) — the intent should not exist, but be safe. */
  readonly hasPhone: boolean;
  readonly phoneType: PhoneType;
  readonly phoneTypeCheckedAt: Date | null;
  /** IANA zone if known from the source (US state, say). Null → conservative window. */
  readonly timezone: string | null;
  readonly skip: boolean;
  readonly erasedAt: Date | null;
}

export interface IntentSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly useCaseId: string;
  readonly useCase: UseCaseKind;
  readonly purpose: Purpose;
  readonly phoneHash: string;
  /** ISO country of the recipient's number. Picks every rule (invariant 2). */
  readonly recipientRegion: string;
  readonly eventTs: Date;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly attemptsCount: number;
  readonly externalRef: string;
  readonly locale: string;
  readonly campaignId: string | null;
}

export interface GateInput {
  readonly tenant: TenantSnapshot;
  readonly contact: ContactSnapshot;
  readonly intent: IntentSnapshot;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Ports. Each is the narrowest question the gate needs answered.
// ---------------------------------------------------------------------------

export interface EnginePort {
  /** ENGINE_DEFAULT_IN / ENGINE_DEFAULT_US, or the tenant override; null if region unroutable. */
  defaultFor(region: string): string | null;
  secondaryFor(region: string): string | null;
  isCircuitOpen(engine: string): Promise<boolean>;
  maxConcurrency(engine: string): number;
}

export interface KillSwitchPort {
  isActive(scope: KillSwitchScope, key: string): Promise<boolean>;
}

export interface SpendPort {
  tenantSpentToday(tenantId: string): Promise<Money>;
  tenantSpentThisMonth(tenantId: string): Promise<Money>;
  /**
   * Platform safety caps are kept PER CURRENCY: an engine bills in its own currency (Retell in
   * dollars, Indian engines in rupees), and one deployment may use both — an Indian merchant
   * calling a US customer. Adding cents to paise would make both caps meaningless.
   */
  engineSpentToday(engine: string, currency: string): Promise<Money>;
  globalSpentToday(currency: string): Promise<Money>;
  /** One cap per currency; an empty list means uncapped. */
  engineDailyCaps(engine: string): readonly Money[];
  globalDailyCaps(): readonly Money[];
}

export interface SuppressionHit {
  readonly id: string;
  readonly scope: 'global' | 'tenant';
  readonly purpose: PurposeScope;
  readonly reason: SuppressionReason;
  readonly externalRef: string | null;
  readonly until: Date | null;
}

export interface SuppressionPort {
  /** Active (not lifted, not past `until` at `now`) rows for this hash: global + this tenant. */
  findActive(tenantId: string, phoneHash: string, now: Date): Promise<readonly SuppressionHit[]>;
}

export interface ConsentHit {
  readonly id: string;
  readonly purpose: PurposeScope;
  readonly source: ConsentSource;
  readonly capturedAt: Date;
  readonly expiresAt: Date | null;
}

export interface ConsentPort {
  /** Grants not revoked. Expiry is evaluated by the gate against `now`, not by the query. */
  findGrants(
    tenantId: string,
    phoneHash: string,
    purposes: readonly PurposeScope[],
  ): Promise<readonly ConsentHit[]>;
}

export interface FlagPort {
  get<T>(tenantId: string, key: string, fallback: T): Promise<T>;
}

export interface DndPort {
  /** Cached 24h by the adapter. 'unknown' on provider failure — the gate decides what that means. */
  scrub(phoneHash: string, region: string, now: Date): Promise<DndResult>;
}

export interface AttemptSummary {
  readonly id: string;
  readonly status: AttemptStatus;
  readonly dispatchedAt: Date | null;
  readonly endedAt: Date | null;
}

export interface AttemptPort {
  /** All attempts for (phone_hash, purpose, external_ref) — the caller filters by time. */
  history(
    tenantId: string,
    phoneHash: string,
    purpose: Purpose,
    externalRef: string,
  ): Promise<readonly AttemptSummary[]>;
  /**
   * ADR-0010: when this tenant last DIALLED this phone for any promotional purpose (any order,
   * any cart), on or after `since`. Null when never.
   */
  lastPromotionalDial(tenantId: string, phoneHash: string, since: Date): Promise<Date | null>;
}

export interface ConcurrencyLease {
  readonly tenantSlot: string;
  readonly engineSlot: string;
  release(): Promise<void>;
}

export interface ConcurrencyPort {
  tryAcquire(
    tenantId: string,
    tenantMax: number,
    engine: string,
    engineMax: number,
  ): Promise<{ ok: true; lease: ConcurrencyLease } | { ok: false; which: 'tenant' | 'engine' }>;
}

export interface NumberCandidate {
  readonly id: string;
  readonly e164: string;
  readonly region: string;
  readonly engine: string;
  readonly purposeAllowed: readonly Purpose[];
  readonly status: string;
  readonly answerRate7d: number | null;
  readonly ownedByTenant: boolean;
  /** STIR/SHAKEN attestation recorded for the number (P6-ENG-2); null = never checked. */
  readonly attestation: 'A' | 'B' | 'C' | null;
}

export interface NumberPort {
  /** Active numbers for the region+engine, tenant-owned first, least-recently-used first. */
  candidates(tenantId: string, region: string, engine: string): Promise<readonly NumberCandidate[]>;
}

export interface ScriptRef {
  readonly id: string;
  readonly version: number;
  readonly locale: string;
  readonly dltTemplateId: string | null;
  /** ADR-0010 §8: `A` or `B` while an A/B test runs, else null. */
  readonly abArm?: string | null;
}

export interface ScriptPort {
  /**
   * The approved script for (use case, locale). While an A/B test runs (two approved arms),
   * the arm is chosen by a stable hash of `bucketKey` (the intent id), so every attempt of one
   * intent hears the same script.
   */
  approved(
    tenantId: string,
    useCaseId: string,
    locale: string,
    bucketKey: string,
  ): Promise<ScriptRef | null>;
}

export interface GateDeps {
  readonly engines: EnginePort;
  readonly killSwitches: KillSwitchPort;
  readonly spend: SpendPort;
  readonly suppressions: SuppressionPort;
  readonly consents: ConsentPort;
  readonly flags: FlagPort;
  readonly dnd: DndPort;
  readonly attempts: AttemptPort;
  readonly concurrency: ConcurrencyPort;
  readonly numbers: NumberPort;
  readonly scripts: ScriptPort;
  /** The region this deployment serves (ADR-0012). Absent → no region check (tests, dev). */
  readonly dataRegion?: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface GateStepRecord {
  readonly step: number;
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  readonly reason?: GateReason;
  readonly ms: number;
}

export interface GateTrace {
  readonly at: string;
  readonly engine: string | null;
  readonly steps: readonly GateStepRecord[];
}

export interface GatePass {
  readonly ok: true;
  readonly engine: string;
  readonly cli: NumberCandidate;
  readonly script: ScriptRef;
  readonly amdMode: AmdMode;
  readonly maxDurationSec: number;
  /** Dial no later than this: min(not_after, window close − buffer). */
  readonly dialDeadline: Date;
  /** Whether the opening must ASK for recording consent in the recipient's region (P6-CMP-1). */
  readonly recordingConsent: 'notice' | 'ask';
  readonly lease: ConcurrencyLease;
  readonly trace: GateTrace;
}

export interface GateFail {
  readonly ok: false;
  readonly reason: GateReason;
  /** Set when the condition is temporary and the intent may be re-gated then. */
  readonly retryAt: Date | null;
  readonly trace: GateTrace;
}

export type GateResult = GatePass | GateFail;
