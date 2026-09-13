import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { addDays } from '@naaradh/shared';
import { explainGate } from './explain.js';

/**
 * The dashboard home: what Naaradh did for the merchant in a period, in business terms —
 * orders confirmed and cancelled before shipping (the RTO that did not happen), calls the
 * compliance layer stopped and why, support calls handled without the merchant's team.
 */

export interface Overview {
  readonly since: Date;
  readonly outbound: {
    readonly orders: number;
    readonly called: number;
    readonly reachedHuman: number;
    readonly confirmed: number;
    readonly cancelledBeforeShip: number;
    readonly billable: number;
    readonly gated: number;
    readonly topGateReasons: {
      readonly code: string;
      readonly title: string;
      readonly count: number;
    }[];
    readonly needsAction: number;
  };
  readonly inbound: {
    readonly calls: number;
    readonly resolvedByAgent: number;
    readonly transferred: number;
    readonly ticketsCreated: number;
    readonly minutes: number;
  };
  readonly ticketsOpen: number;
}

export async function overview(tx: Tx, tenantId: string, now: Date, days = 7): Promise<Overview> {
  const since = addDays(now, -days);

  const [intents] = await tx
    .select({
      orders: sql<number>`count(*)::int`,
      called: sql<number>`count(*) filter (where ${schema.callIntents.attemptsCount} > 0)::int`,
      gated: sql<number>`count(*) filter (where ${schema.callIntents.status} = 'GATED')::int`,
    })
    .from(schema.callIntents)
    .where(
      and(
        eq(schema.callIntents.tenantId, tenantId),
        eq(schema.callIntents.direction, 'outbound'),
        gte(schema.callIntents.createdAt, since),
      ),
    );

  const [outcomes] = await tx
    .select({
      human: sql<number>`count(*) filter (where ${schema.callAttempts.answeredBy} = 'human')::int`,
      confirmed: sql<number>`count(*) filter (where ${schema.callOutcomes.outcome} in ('confirmed','confirmed_with_changes'))::int`,
      cancelled: sql<number>`count(*) filter (where ${schema.callOutcomes.outcome} = 'cancelled')::int`,
      billable: sql<number>`count(*) filter (where ${schema.callOutcomes.billable})::int`,
      needsAction: sql<number>`count(*) filter (where ${schema.callOutcomes.writebackStatus} in ('failed','needs_review') or ${schema.callOutcomes.outcome} in ('needs_merchant_action','callback_requested','convert_to_prepaid_requested'))::int`,
    })
    .from(schema.callOutcomes)
    .innerJoin(schema.callAttempts, eq(schema.callAttempts.id, schema.callOutcomes.attemptId))
    .where(
      and(
        eq(schema.callOutcomes.tenantId, tenantId),
        eq(schema.callAttempts.direction, 'outbound'),
        gte(schema.callOutcomes.createdAt, since),
      ),
    );

  const reasons = await tx
    .select({
      code: schema.callIntents.gatedReason,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.callIntents)
    .where(
      and(
        eq(schema.callIntents.tenantId, tenantId),
        eq(schema.callIntents.status, 'GATED'),
        isNotNull(schema.callIntents.gatedReason),
        gte(schema.callIntents.createdAt, since),
      ),
    )
    .groupBy(schema.callIntents.gatedReason)
    .orderBy(desc(sql`count(*)`))
    .limit(5);

  const [inbound] = await tx
    .select({
      calls: sql<number>`count(*)::int`,
      resolved: sql<number>`count(*) filter (where ${schema.callOutcomes.outcome} = 'resolved')::int`,
      transferred: sql<number>`count(*) filter (where ${schema.callAttempts.transferResult} = 'completed')::int`,
      // Per call, rounded up — the same rule as metering (ADR-0006).
      minutes: sql<number>`coalesce(sum(ceil(coalesce(${schema.callAttempts.billableSec}, ${schema.callAttempts.durationSec}, 0) / 60.0)), 0)::int`,
    })
    .from(schema.callAttempts)
    .leftJoin(schema.callOutcomes, eq(schema.callOutcomes.attemptId, schema.callAttempts.id))
    .where(
      and(
        eq(schema.callAttempts.tenantId, tenantId),
        eq(schema.callAttempts.direction, 'inbound'),
        gte(schema.callAttempts.createdAt, since),
      ),
    );

  const [tickets] = await tx
    .select({
      created: sql<number>`count(*) filter (where ${schema.supportTickets.createdAt} >= ${since})::int`,
      open: sql<number>`count(*) filter (where ${schema.supportTickets.status} <> 'resolved')::int`,
    })
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.tenantId, tenantId));

  return {
    since,
    outbound: {
      orders: intents?.orders ?? 0,
      called: intents?.called ?? 0,
      reachedHuman: outcomes?.human ?? 0,
      confirmed: outcomes?.confirmed ?? 0,
      cancelledBeforeShip: outcomes?.cancelled ?? 0,
      billable: outcomes?.billable ?? 0,
      gated: intents?.gated ?? 0,
      topGateReasons: reasons.flatMap((r) =>
        r.code === null
          ? []
          : [{ code: r.code, title: explainGate(r.code)?.title ?? r.code, count: r.count }],
      ),
      needsAction: outcomes?.needsAction ?? 0,
    },
    inbound: {
      calls: inbound?.calls ?? 0,
      resolvedByAgent: inbound?.resolved ?? 0,
      transferred: inbound?.transferred ?? 0,
      ticketsCreated: tickets?.created ?? 0,
      minutes: inbound?.minutes ?? 0,
    },
    ticketsOpen: tickets?.open ?? 0,
  };
}

/** Why the account is not calling, in one sentence, for the banner on every page. */
export interface AccountBanner {
  readonly tone: 'warning' | 'bad';
  readonly title: string;
  readonly body: string;
}

export function accountBanner(t: {
  readonly status: string;
  readonly pausedReason: string | null;
  readonly billingStatus: string;
  readonly billingGraceUntil: Date | null;
  readonly reviewUntil: Date | null;
}): AccountBanner | null {
  if (t.status === 'suspended')
    return {
      tone: 'bad',
      title: 'Account suspended',
      body: 'Naaradh has suspended calling for this account. Contact support@naaradh.com.',
    };
  if (t.status === 'paused') {
    const reason = t.pausedReason ?? '';
    const body = reason.startsWith('complaints')
      ? 'Calling paused after repeated complaints (E-05). Naaradh staff will review and contact you.'
      : reason === 'app/uninstalled'
        ? 'The Shopify app was uninstalled. Reinstall it to resume.'
        : reason.startsWith('billing')
          ? 'Calling paused for billing. See Billing.'
          : 'Calling is paused. Contact support@naaradh.com for details.';
    return { tone: 'bad', title: 'Calling paused', body };
  }
  if (t.billingStatus === 'capped')
    return {
      tone: 'warning',
      title: 'Spending cap reached',
      body: 'Outbound calls are on hold until you raise your cap or the next billing period starts. See Billing.',
    };
  if (t.billingStatus === 'frozen')
    return {
      tone: 'warning',
      title: 'Payment problem',
      body:
        t.billingGraceUntil === null
          ? 'Your subscription payment failed. Update it to keep calling.'
          : `Your subscription payment failed. Calling continues until ${t.billingGraceUntil.toISOString().slice(0, 10)}; update it to avoid a pause.`,
    };
  if (t.status === 'pending_review')
    return {
      tone: 'warning',
      title: 'New account review',
      body: 'Order confirmation calls work now. Promotional calls unlock after the 7-day review.',
    };
  return null;
}
