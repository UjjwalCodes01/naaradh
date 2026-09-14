import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import { lookup } from 'node:dns/promises';
import {
  isPrivateAddress,
  signMerchantWebhook,
  unixSeconds,
  webhookUrlProblem,
} from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';

/**
 * Outbound merchant webhooks (AGENTS §8): signed `X-Naaradh-Signature: t=…,v1=…`, 5 retries
 * with exponential backoff, then dead (visible in the dashboard). An endpoint that fails 20
 * times in a row is disabled and the merchant notified. Runs with the service role — the
 * outbox spans tenants — and never puts PII on the wire (the payload was built PII-minimised).
 */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;
const MAX_ATTEMPTS = 5;
const DISABLE_AFTER_CONSECUTIVE = 20;

export type PostFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

/** A destination that resolves to a private address: dead immediately, never retried. */
export class UnsafeDestinationError extends Error {
  override readonly name = 'UnsafeDestinationError';
}

/**
 * Defence in depth for merchant-supplied URLs (the API already refuses IPs, private names and
 * our own hosts): the name is resolved here, just before the connection, and refused when any
 * address is private — DNS can be pointed at 169.254.169.254 or 10.x after registration.
 */
export async function assertPublicDestination(url: string): Promise<void> {
  const problem = webhookUrlProblem(url);
  if (problem !== null) throw new UnsafeDestinationError(`destination refused: ${problem}`);
  const { hostname } = new URL(url);
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new UnsafeDestinationError('destination does not resolve');
  if (addresses.some((a) => isPrivateAddress(a.address)))
    throw new UnsafeDestinationError('destination resolves to a private address');
}

export const nodePost: PostFn = async (url, body, headers) => {
  await assertPublicDestination(url);
  const res = await fetch(url, {
    method: 'POST',
    body,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status };
};

export async function deliverOnce(
  ctx: WorkerContext,
  post: PostFn = nodePost,
  limit = 50,
): Promise<{ delivered: number; failed: number; dead: number }> {
  const now = ctx.clock.now();
  const due = await ctx.service
    .select({
      id: schema.merchantWebhookDeliveries.id,
      tenantId: schema.merchantWebhookDeliveries.tenantId,
      webhookId: schema.merchantWebhookDeliveries.webhookId,
      payload: schema.merchantWebhookDeliveries.payload,
      attempts: schema.merchantWebhookDeliveries.attempts,
      url: schema.merchantWebhooks.url,
      secretRef: schema.merchantWebhooks.secretRef,
      active: schema.merchantWebhooks.active,
      consecutiveFailures: schema.merchantWebhooks.consecutiveFailures,
    })
    .from(schema.merchantWebhookDeliveries)
    .innerJoin(
      schema.merchantWebhooks,
      eq(schema.merchantWebhooks.id, schema.merchantWebhookDeliveries.webhookId),
    )
    .where(
      and(
        inArray(schema.merchantWebhookDeliveries.status, ['pending', 'failed']),
        lte(schema.merchantWebhookDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(schema.merchantWebhookDeliveries.nextAttemptAt)
    .limit(limit);

  const counts = { delivered: 0, failed: 0, dead: 0 };
  for (const d of due) {
    if (!d.active) {
      await ctx.service
        .update(schema.merchantWebhookDeliveries)
        .set({ status: 'dead', lastError: 'endpoint disabled' })
        .where(eq(schema.merchantWebhookDeliveries.id, d.id));
      counts.dead += 1;
      continue;
    }
    const body = JSON.stringify(d.payload);
    let status = 0;
    let error: string | null = null;
    try {
      const secret = await ctx.secrets.resolve(d.secretRef);
      const t = unixSeconds(now);
      const res = await post(d.url, body, {
        'content-type': 'application/json',
        'user-agent': 'Naaradh-Webhooks/1.0',
        'x-naaradh-signature': signMerchantWebhook(secret, body, t),
        'x-naaradh-event-id': (d.payload as { id?: string }).id ?? d.id,
      });
      status = res.status;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const ok = status >= 200 && status < 300;
    const attempts = d.attempts + 1;
    const unsafe = error !== null && error.startsWith('destination');
    if (ok) {
      await ctx.service
        .update(schema.merchantWebhookDeliveries)
        .set({
          status: 'delivered',
          attempts,
          lastStatusCode: status,
          lastError: null,
          deliveredAt: now,
          nextAttemptAt: null,
        })
        .where(eq(schema.merchantWebhookDeliveries.id, d.id));
      await ctx.service
        .update(schema.merchantWebhooks)
        .set({ consecutiveFailures: 0 })
        .where(eq(schema.merchantWebhooks.id, d.webhookId));
      counts.delivered += 1;
      continue;
    }
    const dead = unsafe || attempts >= MAX_ATTEMPTS;
    const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 720;
    await ctx.service
      .update(schema.merchantWebhookDeliveries)
      .set({
        status: dead ? 'dead' : 'failed',
        attempts,
        lastStatusCode: status || null,
        lastError: (error ?? `HTTP ${String(status)}`).slice(0, 500),
        nextAttemptAt: dead ? null : new Date(now.getTime() + backoff * 60_000),
      })
      .where(eq(schema.merchantWebhookDeliveries.id, d.id));
    const consecutive = d.consecutiveFailures + 1;
    await ctx.service
      .update(schema.merchantWebhooks)
      .set(
        consecutive >= DISABLE_AFTER_CONSECUTIVE
          ? {
              consecutiveFailures: consecutive,
              active: false,
              disabledAt: now,
              disabledReason: `${String(consecutive)} consecutive failures`,
            }
          : { consecutiveFailures: sql`${schema.merchantWebhooks.consecutiveFailures} + 1` },
      )
      .where(eq(schema.merchantWebhooks.id, d.webhookId));
    if (dead) counts.dead += 1;
    else counts.failed += 1;
  }
  return counts;
}

export async function runDeliveries(
  ctx: WorkerContext,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await runLoop({
    name: 'deliveries',
    log: ctx.log,
    intervalMs,
    signal,
    async tick() {
      const r = await deliverOnce(ctx);
      if (r.delivered + r.failed + r.dead > 0) ctx.log.info(r, 'deliveries pass');
    },
  });
}
