import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@naaradh/db';
import { NaaradhError, newId } from '@naaradh/shared';
import { audit } from './audit.js';
import { auditActor, type Actor } from './admin/actor.js';

/**
 * P7-GTM-1: one merchant referring another (ADR-0017).
 *
 * The terms live here as constants, not in configuration, on purpose: a referral reward is a
 * billing credit, and invariant 11 puts every billing change behind a written product decision.
 * Changing them is a reviewed pull request that updates ADR-0017 in the same change.
 */
export const REFERRAL_TERMS = {
  /** A referral is how you joined: it can be claimed only this soon after the account exists. */
  claimWindowDays: 30,
  /** The referred merchant must have been paying, and not left, for this long. */
  qualifyAfterDays: 60,
  /**
   * The referrer's credit, in minor units of the REFERRER's currency. `null` = no reward yet:
   * referrals are recorded and qualified, and nothing is credited. Set only with ADR-0017
   * accepted — the amount is a product decision, not an engineering one.
   */
  reward: null as Readonly<Record<string, number>> | null,
} as const;

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const REFERRAL_CODE = /^[A-HJ-KMNP-Z2-9]{8}$/;

export function newReferralCode(): string {
  let out = '';
  while (out.length < 8)
    for (const b of randomBytes(16))
      if (b < 248 && out.length < 8) out += ALPHABET.charAt(b % ALPHABET.length);
  return out;
}

/** The tenant's own code, created on first use. */
export async function ensureReferralCode(tx: Tx, tenantId: string): Promise<string> {
  const [existing] = await tx
    .select({ code: schema.referralCodes.code })
    .from(schema.referralCodes)
    .where(eq(schema.referralCodes.tenantId, tenantId))
    .limit(1);
  if (existing !== undefined) return existing.code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newReferralCode();
    const inserted = await tx
      .insert(schema.referralCodes)
      .values({ id: newId('referralCode'), tenantId, code })
      .onConflictDoNothing()
      .returning({ code: schema.referralCodes.code });
    if (inserted[0] !== undefined) return inserted[0].code;
    // Either another request created this tenant's code first, or the code collided.
    const [again] = await tx
      .select({ code: schema.referralCodes.code })
      .from(schema.referralCodes)
      .where(eq(schema.referralCodes.tenantId, tenantId))
      .limit(1);
    if (again !== undefined) return again.code;
  }
  throw new NaaradhError('INTERNAL', 'could not create a referral code');
}

const CLAIM_MESSAGES: Readonly<Record<string, string>> = {
  unknown_code: 'No account has that referral code.',
  self: 'That is your own referral code.',
  already_referred: 'This account already named who referred it.',
  too_late: `A referral code can be entered only in the first ${String(REFERRAL_TERMS.claimWindowDays)} days.`,
  same_people: 'That code belongs to an account run by the same people as this one.',
  referrer_inactive: 'That referral code is no longer active.',
};

export async function claimReferral(
  tx: Tx,
  actor: Actor,
  code: string,
  now: Date,
): Promise<{ referrerName: string }> {
  const clean = code.trim().toUpperCase();
  if (!REFERRAL_CODE.test(clean))
    throw new NaaradhError('VALIDATION_FAILED', 'a referral code is 8 letters and numbers');
  let row: { outcome: string; referrer_name: string | null } | undefined;
  try {
    const r = await tx.execute<{ outcome: string; referrer_name: string | null }>(
      sql`select * from claim_referral(${newId('referral')}, ${clean}, ${now}, ${REFERRAL_TERMS.claimWindowDays})`,
    );
    row = r.rows[0];
  } catch (error) {
    // Two claims raced: the unique index let one through.
    if (String((error as { cause?: { code?: string } }).cause?.code) === '23505')
      throw new NaaradhError('VALIDATION_FAILED', CLAIM_MESSAGES['already_referred'] ?? '');
    throw error;
  }
  if (row === undefined || row.outcome !== 'claimed')
    throw new NaaradhError(
      'VALIDATION_FAILED',
      CLAIM_MESSAGES[row?.outcome ?? ''] ?? 'That referral code cannot be used.',
    );
  await audit(tx, {
    ...auditActor(actor),
    action: 'referral.claimed',
    targetType: 'tenant',
    targetId: actor.tenantId,
    after: { code: clean },
  });
  return { referrerName: row.referrer_name ?? '' };
}

export interface ReferralSummary {
  readonly code: string;
  readonly referredBy: { readonly status: string; readonly claimedAt: Date } | null;
  readonly referred: readonly {
    readonly name: string;
    readonly status: string;
    readonly claimedAt: Date;
    readonly qualifiedAt: Date | null;
    readonly rewardedAt: Date | null;
  }[];
  readonly rewardActive: boolean;
}

export async function referralSummary(tx: Tx, tenantId: string): Promise<ReferralSummary> {
  const code = await ensureReferralCode(tx, tenantId);
  const rows = await tx
    .select()
    .from(schema.referrals)
    .where(
      or(eq(schema.referrals.tenantId, tenantId), eq(schema.referrals.referrerTenantId, tenantId)),
    );
  const mine = rows.find((r) => r.tenantId === tenantId);
  return {
    code,
    referredBy: mine === undefined ? null : { status: mine.status, claimedAt: mine.claimedAt },
    referred: rows
      .filter((r) => r.referrerTenantId === tenantId)
      .sort((a, b) => b.claimedAt.getTime() - a.claimedAt.getTime())
      .map((r) => ({
        name: r.referredName,
        status: r.status,
        claimedAt: r.claimedAt,
        qualifiedAt: r.qualifiedAt,
        rewardedAt: r.rewardedAt,
      })),
    rewardActive: REFERRAL_TERMS.reward !== null,
  };
}

// ---- the nightly sweep (billing worker, service role) --------------------------------------------

export interface ReferralSweepReport {
  readonly qualified: number;
  readonly voided: number;
  readonly rewarded: number;
  readonly awaitingReward: number;
}

const CHARGE_KINDS = ['platform_fee', 'outcome', 'minute'] as const;

/**
 * Moves referrals on: `claimed` → `void` when the referred merchant left or was suspended
 * first; → `qualified` once it has paid for real use and stayed `qualifyAfterDays`; `qualified`
 * → `rewarded` when a reward is set for the referrer's currency. Every transition is audited on
 * both tenants. Safe to run twice: each step re-checks the status it expects, and the credit's
 * ledger `ref` is the referral id, which the ledger's unique index allows once.
 */
export async function runReferralSweep(
  service: Db,
  now: Date,
  reward: Readonly<Record<string, number>> | null = REFERRAL_TERMS.reward,
): Promise<ReferralSweepReport> {
  let qualified = 0;
  let voided = 0;
  let rewarded = 0;
  let awaitingReward = 0;
  const cutoff = new Date(now.getTime() - REFERRAL_TERMS.qualifyAfterDays * 86_400_000);

  const claimed = await service
    .select({
      id: schema.referrals.id,
      tenantId: schema.referrals.tenantId,
      referrerTenantId: schema.referrals.referrerTenantId,
      claimedAt: schema.referrals.claimedAt,
      referredStatus: schema.tenants.status,
    })
    .from(schema.referrals)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.referrals.tenantId))
    .where(eq(schema.referrals.status, 'claimed'));

  for (const r of claimed) {
    if (r.referredStatus === 'uninstalled' || r.referredStatus === 'suspended') {
      await service.transaction(async (tx) => {
        const moved = await tx
          .update(schema.referrals)
          .set({ status: 'void', voidReason: `referred account ${r.referredStatus}` })
          .where(and(eq(schema.referrals.id, r.id), eq(schema.referrals.status, 'claimed')))
          .returning({ id: schema.referrals.id });
        if (moved.length === 0) return;
        await auditBoth(tx, r, 'referral.voided', { reason: r.referredStatus });
        voided += 1;
      });
      continue;
    }
    if (r.claimedAt > cutoff || r.referredStatus !== 'active') continue;
    const [paid] = await service
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.billingLedger)
      .where(
        and(
          eq(schema.billingLedger.tenantId, r.tenantId),
          inArray(schema.billingLedger.kind, [...CHARGE_KINDS]),
          gt(schema.billingLedger.totalMinor, 0),
          lte(schema.billingLedger.createdAt, now),
        ),
      );
    if ((paid?.n ?? 0) === 0) continue;
    await service.transaction(async (tx) => {
      const moved = await tx
        .update(schema.referrals)
        .set({ status: 'qualified', qualifiedAt: now })
        .where(and(eq(schema.referrals.id, r.id), eq(schema.referrals.status, 'claimed')))
        .returning({ id: schema.referrals.id });
      if (moved.length === 0) return;
      await auditBoth(tx, r, 'referral.qualified', {});
      qualified += 1;
    });
  }

  const due = await service
    .select({
      id: schema.referrals.id,
      tenantId: schema.referrals.tenantId,
      referrerTenantId: schema.referrals.referrerTenantId,
      currency: schema.tenants.currency,
      provider: schema.tenants.billingProvider,
      referrerStatus: schema.tenants.status,
    })
    .from(schema.referrals)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.referrals.referrerTenantId))
    .where(eq(schema.referrals.status, 'qualified'));

  for (const r of due) {
    const amount = reward?.[r.currency];
    // No reward decided for this currency yet, no way to credit the referrer, or the referrer is
    // gone: stay qualified. Nothing is lost; the next run with a reward set pays it.
    if (
      amount === undefined ||
      amount <= 0 ||
      r.provider === null ||
      r.referrerStatus === 'uninstalled' ||
      r.referrerStatus === 'suspended'
    ) {
      awaitingReward += 1;
      continue;
    }
    await service.transaction(async (tx) => {
      const ledgerId = newId('ledger');
      const inserted = await tx
        .insert(schema.billingLedger)
        .values({
          id: ledgerId,
          tenantId: r.referrerTenantId,
          kind: 'credit',
          ref: r.id,
          qty: 1,
          unitMinor: -amount,
          totalMinor: -amount,
          currency: r.currency,
          period: now.toISOString().slice(0, 7),
          provider: r.provider as NonNullable<typeof r.provider>,
          notes: `referral credit${r.provider === 'shopify' ? ' — apply in Partner Dashboard' : ''}`,
        })
        .onConflictDoNothing()
        .returning({ id: schema.billingLedger.id });
      const creditId = inserted[0]?.id ?? null;
      const moved = await tx
        .update(schema.referrals)
        .set({ status: 'rewarded', rewardedAt: now, creditLedgerId: creditId })
        .where(and(eq(schema.referrals.id, r.id), eq(schema.referrals.status, 'qualified')))
        .returning({ id: schema.referrals.id });
      if (moved.length === 0) return;
      await auditBoth(tx, r, 'referral.rewarded', {
        credit_ledger_id: creditId,
        amount_minor: amount,
        currency: r.currency,
      });
      rewarded += 1;
    });
  }
  return { qualified, voided, rewarded, awaitingReward };
}

async function auditBoth(
  tx: Tx,
  r: { id: string; tenantId: string; referrerTenantId: string },
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  for (const tenantId of [r.tenantId, r.referrerTenantId])
    await audit(tx, {
      tenantId,
      actorType: 'system',
      actorId: 'referrals',
      action,
      targetType: 'referral',
      targetId: r.id,
      after,
    });
}
