import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withTenant, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { newId } from '@naaradh/shared';
import {
  REFERRAL_TERMS,
  claimReferral,
  ensureReferralCode,
  referralSummary,
  runReferralSweep,
  type Actor,
} from '../../src/index.js';

/**
 * P7-GTM-1 referrals: the anti-abuse rules live in the database (claim_referral), so they are
 * proven against a real one. The reward is off in code (ADR-0017); the sweep is also run with a
 * test-only reward to prove the credit is written once, and only once.
 */

const NOW = new Date('2026-09-28T06:30:00Z');
const REFERRER = newId('tenant');
const NEWCOMER = newId('tenant');
const OLD = newId('tenant');
const TWIN = newId('tenant');
const STRANGER = newId('tenant');
const GONE = newId('tenant');
const LATER = newId('tenant');

let pg: TestPostgres;
let service: RoleClient;
let app: Db;
let svc: Db;
let closers: (() => Promise<void>)[] = [];
let code = '';
let goneCode = '';

const owner = (tenantId: string): Actor => ({ tenantId, type: 'user', id: newId('user') });
const claim = (tenantId: string, c: string, at = NOW) =>
  withTenant(app, tenantId, (tx) => claimReferral(tx, owner(tenantId), c, at));
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

beforeAll(async () => {
  pg = await startTestPostgres();
  service = new RoleClient(pg.urls.service);
  for (const [id, name, created, status] of [
    [REFERRER, 'Referrer', daysAgo(400), 'active'],
    [NEWCOMER, 'Newcomer', daysAgo(5), 'active'],
    [OLD, 'Old store', daysAgo(45), 'active'],
    [TWIN, 'Twin store', daysAgo(2), 'active'],
    [STRANGER, 'Stranger', daysAgo(100), 'active'],
    [GONE, 'Gone', daysAgo(300), 'suspended'],
    [LATER, 'Later', daysAgo(3), 'active'],
  ] as const)
    await service.query(
      `insert into tenants (id, name, country, data_region, status, billing_provider, created_at) values ($1, $2, 'IN', 'in', $3, 'razorpay', $4)`,
      [id, name, status, created],
    );
  await service.query(
    `insert into users (id, tenant_id, email, role) values
       ($1, $4, 'founder@referrer.example', 'owner'),
       ($2, $5, 'founder@referrer.example', 'viewer'),
       ($3, $6, 'owner@newcomer.example', 'owner')`,
    [newId('user'), newId('user'), newId('user'), REFERRER, TWIN, NEWCOMER],
  );
  const a = createDb({ url: pg.urls.app, max: 3 });
  const s = createDb({ url: pg.urls.service, max: 2 });
  app = a.db;
  svc = s.db;
  closers = [a.close, s.close];
  code = await withTenant(app, REFERRER, (tx) => ensureReferralCode(tx, REFERRER));
  goneCode = await withTenant(app, GONE, (tx) => ensureReferralCode(tx, GONE));
}, 180_000);

afterAll(async () => {
  for (const c of closers) await c();
  await service.end();
  await pg.stop();
});

describe('codes', () => {
  it('are 8 characters without look-alikes, and stable per account', async () => {
    expect(code).toMatch(/^[A-HJ-KMNP-Z2-9]{8}$/);
    expect(await withTenant(app, REFERRER, (tx) => ensureReferralCode(tx, REFERRER))).toBe(code);
  });
});

describe('claiming refuses every abuse the rules name', () => {
  it('an unknown code', async () => {
    await expect(claim(NEWCOMER, 'ZZZZZZZZ')).rejects.toThrow(/No account has that/);
  });
  it('a malformed code, before touching the database', async () => {
    await expect(claim(NEWCOMER, "x' or 1=1")).rejects.toThrow(/8 letters/);
  });
  it('your own code', async () => {
    await expect(claim(REFERRER, code)).rejects.toThrow(/your own/);
  });
  it('an account older than the claim window', async () => {
    await expect(claim(OLD, code)).rejects.toThrow(
      new RegExp(`first ${String(REFERRAL_TERMS.claimWindowDays)} days`),
    );
  });
  it("an account run by the referrer's own owner (self-referral through a second account)", async () => {
    await expect(claim(TWIN, code)).rejects.toThrow(/same people/);
  });
  it('a suspended referrer', async () => {
    await expect(claim(LATER, goneCode)).rejects.toThrow(/no longer active/);
  });
  it('accepts a genuine referral, case-insensitively, and names the referrer', async () => {
    await expect(claim(NEWCOMER, code.toLowerCase())).resolves.toEqual({
      referrerName: 'Referrer',
    });
  });
  it('only once', async () => {
    await expect(claim(NEWCOMER, code)).rejects.toThrow(/already named/);
  });
});

describe('visibility', () => {
  it('both sides see the referral; the referrer sees the name snapshot', async () => {
    const mine = await withTenant(app, NEWCOMER, (tx) => referralSummary(tx, NEWCOMER));
    expect(mine.referredBy?.status).toBe('claimed');
    const theirs = await withTenant(app, REFERRER, (tx) => referralSummary(tx, REFERRER));
    expect(theirs.referred).toEqual([
      expect.objectContaining({ name: 'Newcomer', status: 'claimed' }),
    ]);
  });
  it('negative: a third account sees nothing (RLS)', async () => {
    const r = await withTenant(app, STRANGER, (tx) =>
      tx.execute(sql`select count(*)::int as n from referrals`),
    );
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });
  it('negative: the app role cannot write a referral directly, only through the rules', async () => {
    await expect(
      withTenant(app, STRANGER, (tx) =>
        tx.execute(
          sql`insert into referrals (id, tenant_id, referrer_tenant_id, code, referred_name, claimed_at) values (${newId('referral')}, ${STRANGER}, ${REFERRER}, ${code}, 'x', now())`,
        ),
      ),
    ).rejects.toSatisfy((e: unknown) =>
      /permission denied/.test(String((e as { cause?: unknown }).cause ?? e)),
    );
  });
  it('the reward is off until ADR-0017 sets it', () => {
    expect(REFERRAL_TERMS.reward).toBeNull();
  });
});

describe('the nightly sweep', () => {
  const credits = async () =>
    (
      await service.query<{ total: string }>(
        `select total_minor::text as total from billing_ledger where tenant_id = $1 and kind = 'credit'`,
        [REFERRER],
      )
    ).rows;
  const status = async () =>
    (
      await service.query<{ status: string }>(`select status from referrals where tenant_id = $1`, [
        NEWCOMER,
      ])
    ).rows[0]?.status;

  it('does nothing before the qualifying period', async () => {
    expect(await runReferralSweep(svc, NOW)).toMatchObject({ qualified: 0 });
    expect(await status()).toBe('claimed');
  });

  it('does nothing after the period if the store never paid', async () => {
    expect(await runReferralSweep(svc, daysAgo(-61))).toMatchObject({ qualified: 0 });
  });

  it('qualifies once the store has paid and stayed', async () => {
    await service.query(
      `insert into billing_ledger (id, tenant_id, kind, ref, qty, unit_minor, total_minor, currency, period, provider)
       values ($1, $2, 'platform_fee', '2026-10', 1, 99900, 99900, 'INR', '2026-10', 'razorpay')`,
      [newId('ledger'), NEWCOMER],
    );
    expect(await runReferralSweep(svc, daysAgo(-61))).toMatchObject({
      qualified: 1,
      awaitingReward: 1,
    });
    expect(await status()).toBe('qualified');
  });

  it('with no reward decided, credits nothing and keeps it waiting', async () => {
    expect(await runReferralSweep(svc, daysAgo(-62))).toMatchObject({
      rewarded: 0,
      awaitingReward: 1,
    });
    expect(await credits()).toEqual([]);
  });

  it('with a reward set, credits the referrer exactly once', async () => {
    const reward = { INR: 50000 };
    expect(await runReferralSweep(svc, daysAgo(-63), reward)).toMatchObject({ rewarded: 1 });
    expect(await runReferralSweep(svc, daysAgo(-64), reward)).toMatchObject({ rewarded: 0 });
    expect(await credits()).toEqual([{ total: '-50000' }]);
    expect(await status()).toBe('rewarded');
  });

  it('voids a referral whose store left before qualifying, audited on both sides', async () => {
    await service.query(`update tenants set created_at = $1 where id = $2`, [daysAgo(1), LATER]);
    await claim(LATER, code);
    await service.query(`update tenants set status = 'uninstalled' where id = $1`, [LATER]);
    expect(await runReferralSweep(svc, NOW)).toMatchObject({ voided: 1 });
    const audits = await service.query<{ tenant_id: string }>(
      `select tenant_id from audit_log where action = 'referral.voided'`,
    );
    expect(audits.rows.map((r) => r.tenant_id).sort()).toEqual([LATER, REFERRER].sort());
  });
});
