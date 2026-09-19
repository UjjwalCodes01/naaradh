import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { newId } from '@naaradh/shared';
import { billingCurrencyOf, effectivePlan, planTenantOf, type BillingCurrency } from './plans.js';

/**
 * Turning ledger rows into provider charges (ADR-0008). SERVICE role: it scans all tenants.
 *
 *   shopify   one posting per chargeable ledger row (total > 0), keyed by the ledger id
 *   razorpay  one posting per tenant per CLOSED period — an add-on for the period's overage
 *   stripe    the same, as an invoice item on the subscription's next invoice (P6-BILL-1)
 *   manual    nothing; finance invoices from the ledger
 *
 * A posting is created only while the tenant has an ACTIVE subscription at that provider; rows
 * metered before a subscription existed are posted once one does (same period only for
 * Shopify — a usage record is always charged in the current interval).
 */

interface ChargeableRow {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'outcome' | 'minute' | 'credit';
  readonly ref: string | null;
  readonly qty: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly period: string;
}

async function unpostedRows(
  tx: Tx,
  provider: DirectProvider | 'shopify',
  limit: number,
  periodFilter: 'current' | 'closed',
  period: string,
): Promise<ChargeableRow[]> {
  const rows = await tx.execute<{
    id: string;
    tenant_id: string;
    kind: 'outcome' | 'minute' | 'credit';
    ref: string | null;
    qty: number;
    total_minor: string;
    currency: string;
    period: string;
  }>(sql`
    select l.id, l.tenant_id, l.kind, l.ref, l.qty, l.total_minor, l.currency, l.period
    from billing_ledger l
    join tenants t on t.id = l.tenant_id
    where (l.total_minor > 0 and l.kind in ('outcome', 'minute')
           -- credits (accepted disputes) net out of a Razorpay/Stripe period; Shopify refunds are manual
           or (${provider} in ('razorpay', 'stripe') and l.kind = 'credit'))
      and t.billing_provider = ${provider}
      and ${periodFilter === 'current' ? sql`l.period = ${period}` : sql`l.period < ${period}`}
      and not exists (select 1 from billing_postings p where p.ledger_ids @> array[l.id])
    order by l.created_at
    limit ${limit}
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    ref: r.ref,
    qty: r.qty,
    totalMinor: Number(r.total_minor),
    currency: r.currency,
    period: r.period,
  }));
}

/** Providers billed once per closed period (an add-on / invoice item), not per ledger row. */
type DirectProvider = 'razorpay' | 'stripe';

async function activeSubscription(tx: Tx, tenantId: string, provider: DirectProvider | 'shopify') {
  const [sub] = await tx
    .select({
      id: schema.billingSubscriptions.id,
      currency: schema.billingSubscriptions.currency,
      lineItemId: schema.billingSubscriptions.providerLineItemId,
    })
    .from(schema.billingSubscriptions)
    .where(
      and(
        eq(schema.billingSubscriptions.tenantId, tenantId),
        eq(schema.billingSubscriptions.provider, provider),
        eq(schema.billingSubscriptions.status, 'active'),
      ),
    )
    .limit(1);
  return sub ?? null;
}

/**
 * The amount a ledger row is worth in the provider's currency. Same currency → the ledger total.
 * Otherwise (INR tenant billed by Shopify in USD) → quantity × the plan's price in that currency;
 * never an FX rate on the fly, so a charge is always a price the merchant saw.
 */
export async function providerAmount(
  tx: Tx,
  row: ChargeableRow,
  currency: BillingCurrency,
): Promise<number> {
  if (row.currency === currency) return row.totalMinor;
  const [tenant] = await tx
    .select({
      planCode: schema.tenants.planCode,
      inboundPlanCode: schema.tenants.inboundPlanCode,
      billingOverrides: schema.tenants.billingOverrides,
      currency: schema.tenants.currency,
    })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, row.tenantId))
    .limit(1);
  if (tenant === undefined) return 0;
  const plan = effectivePlan(
    row.kind === 'minute' ? 'inbound' : 'outbound',
    planTenantOf(tenant),
    currency,
  );
  return row.qty * plan.unitMinor;
}

function describe(row: ChargeableRow): string {
  return row.kind === 'minute'
    ? `Naaradh support line: ${String(row.qty)} extra minute${row.qty === 1 ? '' : 's'} (${row.period})`
    : `Naaradh: confirmed-order call outcome ${row.ref ?? ''} (${row.period})`.trim();
}

export interface PostingsCreated {
  readonly shopify: number;
  readonly razorpay: number;
  readonly stripe: number;
}

export async function createPostings(tx: Tx, now: Date, limit = 500): Promise<PostingsCreated> {
  const period = now.toISOString().slice(0, 7);
  let shopify = 0;
  for (const row of await unpostedRows(tx, 'shopify', limit, 'current', period)) {
    const sub = await activeSubscription(tx, row.tenantId, 'shopify');
    if (sub === null || sub.lineItemId === null) continue;
    const currency = billingCurrencyOf(sub.currency);
    const amount = await providerAmount(tx, row, currency);
    if (amount <= 0) continue;
    const inserted = await tx
      .insert(schema.billingPostings)
      .values({
        id: newId('billingPosting'),
        tenantId: row.tenantId,
        provider: 'shopify',
        kind: 'usage_record',
        subscriptionId: sub.id,
        period: row.period,
        ledgerIds: [row.id],
        amountMinor: amount,
        currency: sub.currency,
        description: describe(row),
        idempotencyKey: row.id,
        status: 'pending',
        nextAttemptAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.billingPostings.id });
    shopify += inserted.length;
  }

  const razorpay = await periodPostings(tx, 'razorpay', period, now);
  const stripe = await periodPostings(tx, 'stripe', period, now);
  return { shopify, razorpay, stripe };
}

/**
 * Razorpay and Stripe: each closed period per tenant becomes one charge for its overage, in the
 * subscription's currency, net of accepted-dispute credits in that currency. Rows in another
 * currency are left for a person (they mean the tenant's currency changed mid-period).
 */
async function periodPostings(
  tx: Tx,
  provider: DirectProvider,
  period: string,
  now: Date,
): Promise<number> {
  let created = 0;
  const closed = await unpostedRows(tx, provider, 5_000, 'closed', period);
  const groups = new Map<string, ChargeableRow[]>();
  for (const r of closed) {
    const k = `${r.tenantId}|${r.period}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [key, rows] of groups) {
    const [tenantId, rowPeriod] = key.split('|') as [string, string];
    const sub = await activeSubscription(tx, tenantId, provider);
    if (sub === null) continue;
    const currency = provider === 'razorpay' ? 'INR' : sub.currency;
    const same = rows.filter((r) => r.currency === currency);
    const amount = same.reduce((a, r) => a + r.totalMinor, 0);
    if (amount <= 0) continue;
    const credits = same.filter((r) => r.kind === 'credit').reduce((a, r) => a - r.totalMinor, 0);
    const outcomes = same.filter((r) => r.kind === 'outcome').reduce((a, r) => a + r.qty, 0);
    const minutes = same.filter((r) => r.kind === 'minute').reduce((a, r) => a + r.qty, 0);
    const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
    const inserted = await tx
      .insert(schema.billingPostings)
      .values({
        id: newId('billingPosting'),
        tenantId,
        provider,
        kind: 'addon',
        subscriptionId: sub.id,
        period: rowPeriod,
        ledgerIds: same.map((r) => r.id),
        amountMinor: amount,
        currency,
        description: `Naaradh usage ${rowPeriod}: ${String(outcomes)} extra outcomes, ${String(minutes)} extra minutes${credits > 0 ? `, less ${symbol}${(credits / 100).toFixed(2)} credit` : ''}`,
        idempotencyKey: `${provider === 'razorpay' ? 'rzp' : 'stripe'}:${tenantId}:${rowPeriod}`,
        status: 'pending',
        nextAttemptAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.billingPostings.id });
    created += inserted.length;
  }
  return created;
}

export interface ClaimedPosting {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: 'shopify' | DirectProvider;
  readonly subscriptionId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly attempts: number;
}

/** SKIP LOCKED claim with a lease: a crashed worker's posting comes back after `leaseMin`. */
export async function claimPostings(
  tx: Tx,
  now: Date,
  batch: number,
  leaseMin = 5,
): Promise<ClaimedPosting[]> {
  const rows = await tx.execute<{
    id: string;
    tenant_id: string;
    provider: 'shopify' | DirectProvider;
    subscription_id: string | null;
    amount_minor: string;
    currency: string;
    description: string;
    idempotency_key: string;
    attempts: number;
  }>(sql`
    update billing_postings
    set attempts = attempts + 1, next_attempt_at = ${new Date(now.getTime() + leaseMin * 60_000)}::timestamptz
    where id in (
      select id from billing_postings
      where status in ('pending', 'failed') and next_attempt_at is not null and next_attempt_at <= ${now}::timestamptz
      order by next_attempt_at
      limit ${batch}
      for update skip locked
    )
    returning id, tenant_id, provider, subscription_id, amount_minor, currency, description, idempotency_key, attempts
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    subscriptionId: r.subscription_id,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    description: r.description,
    idempotencyKey: r.idempotency_key,
    attempts: r.attempts,
  }));
}

export async function settlePosting(
  tx: Tx,
  id: string,
  result:
    | { readonly status: 'posted'; readonly providerRef: string; readonly at: Date }
    | { readonly status: 'capped' | 'skipped'; readonly error: string }
    | { readonly status: 'failed'; readonly error: string; readonly retryAt: Date | null },
): Promise<void> {
  await tx
    .update(schema.billingPostings)
    .set(
      result.status === 'posted'
        ? {
            status: 'posted',
            providerRef: result.providerRef,
            postedAt: result.at,
            nextAttemptAt: null,
            lastError: null,
          }
        : result.status === 'failed'
          ? {
              status: 'failed',
              lastError: result.error.slice(0, 500),
              nextAttemptAt: result.retryAt,
            }
          : { status: result.status, lastError: result.error.slice(0, 500), nextAttemptAt: null },
    )
    .where(eq(schema.billingPostings.id, id));
}

/** For the dashboard and reconciliation: what was posted to a provider for a tenant/period. */
export async function postedTotal(tx: Tx, tenantId: string, period: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`coalesce(sum(${schema.billingPostings.amountMinor}), 0)` })
    .from(schema.billingPostings)
    .where(
      and(
        eq(schema.billingPostings.tenantId, tenantId),
        eq(schema.billingPostings.period, period),
        inArray(schema.billingPostings.status, ['posted']),
      ),
    );
  return Number(row?.n ?? 0);
}
