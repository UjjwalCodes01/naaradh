import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema, withTenant, type Db, type DbOrTx } from '@naaradh/db';
import {
  ABANDONED_CART_IDLE_MINUTES,
  ABANDONED_CART_MAX_AGE_HOURS,
  PROMOTIONAL_COOLDOWN_DAYS,
  recordConsent,
  revokeConsent,
} from '@naaradh/compliance';
import { addMinutes, newId, type PhoneRegion } from '@naaradh/shared';
import { audit } from '../audit.js';
import { cancelIntents } from '../cancel.js';
import { upsertContact, type PhoneKeys } from '../contacts.js';
import { createIntent } from '../intents.js';
import { isKnownConsentWording } from './consent-wording.js';

/**
 * Abandoned checkouts (ADR-0010 §1). `recordCheckout` keeps the newest state of a checkout and
 * records consent the moment it is given; `sweepAbandonedCheckouts` turns an idle, consented
 * checkout into exactly one abandoned-cart intent. The two halves meet only through the
 * `checkouts` row, so the 45-minute debounce, a phone typed late, a phone changed, a checkout
 * completed or an order placed from elsewhere are all the same question at sweep time:
 * "what is true about this checkout now?"
 */

/**
 * Where the cart came from: `shopify` (webhooks), `woocommerce` or `api` (ADR-0011 §1), or a
 * one-click-checkout provider's name once one is contracted (Q-09). One row per (tenant,
 * source, ref), so two platforms reporting the same cart cannot produce two calls (E-139).
 */
export type CheckoutSource = string;

/** The `intent_source` enum value for a cart source; anything unknown is plain `api`. */
export function intentSourceFor(source: string): 'shopify' | 'woocommerce' | 'api' {
  return source === 'shopify' ? 'shopify' : source === 'woocommerce' ? 'woocommerce' : 'api';
}

export interface CheckoutInput {
  readonly tenantId: string;
  readonly source: CheckoutSource;
  readonly externalId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly rawPhone: string | null;
  readonly defaultRegion: PhoneRegion;
  readonly firstName: string | null;
  readonly valueMinor: number;
  readonly currency: string;
  readonly itemSummary: string;
  readonly itemCount: number;
  /** Our checkbox attribute: a wording version, or null when not ticked. */
  readonly consentAttribute: string | null;
  readonly customerTags: readonly string[];
  readonly isDraftOrPos: boolean;
  readonly now: Date;
}

export type RecordCheckoutResult =
  | { readonly kind: 'ignored'; readonly reason: 'draft_or_pos' | 'staff_customer' | 'stale' }
  | {
      readonly kind: 'recorded';
      readonly checkoutId: string;
      readonly status: string;
      readonly consent: 'granted' | 'revoked' | 'unchanged' | 'unknown_wording';
      readonly cancelledIntents: number;
    };

const OPEN_LIKE = ['open', 'skipped'] as const;

/**
 * Upsert one checkout webhook. Newest `updatedAt` wins (E-104); a completed checkout never
 * reopens; a skipped one reopens on a newer update (the shopper came back and, say, typed a
 * phone or ticked the box).
 */
export async function recordCheckout(
  tx: DbOrTx,
  keys: PhoneKeys,
  input: CheckoutInput,
): Promise<RecordCheckoutResult> {
  if (input.isDraftOrPos) return { kind: 'ignored', reason: 'draft_or_pos' };
  // E-46: staff never get a recovery call.
  if (
    input.customerTags.some(
      (t) => t.toLowerCase() === 'staff' || t.toLowerCase() === 'naaradh:skip',
    )
  )
    return { kind: 'ignored', reason: 'staff_customer' };

  const [existing] = await tx
    .select()
    .from(schema.checkouts)
    .where(
      and(
        eq(schema.checkouts.tenantId, input.tenantId),
        eq(schema.checkouts.source, input.source),
        eq(schema.checkouts.externalId, input.externalId),
      ),
    )
    .for('update')
    .limit(1);
  if (
    existing !== undefined &&
    existing.sourceUpdatedAt > input.updatedAt &&
    input.completedAt === null
  )
    return { kind: 'ignored', reason: 'stale' };
  if (existing?.erasedAt !== null && existing?.erasedAt !== undefined)
    return { kind: 'ignored', reason: 'stale' };

  // The phone becomes a contact (encrypted once, hashed for every lookup); nothing raw is kept.
  let contact: { contactId: string; phoneHash: string; region: string } | null = null;
  if (input.rawPhone !== null && input.rawPhone.trim().length > 0) {
    const c = await upsertContact(tx, keys, {
      tenantId: input.tenantId,
      rawPhone: input.rawPhone,
      defaultRegion: input.defaultRegion,
      name: input.firstName,
      source: `${input.source}:checkout`,
      at: input.now,
    });
    if (c.ok && !c.erased)
      contact = { contactId: c.contactId, phoneHash: c.phoneHash, region: c.phone.region };
  }

  const completed = input.completedAt !== null;
  const wasTerminal =
    existing !== undefined &&
    (existing.status === 'completed' ||
      existing.status === 'converted' ||
      existing.status === 'expired');
  const nextStatus = completed
    ? 'completed'
    : existing === undefined
      ? 'open'
      : wasTerminal || existing.status === 'scheduled'
        ? existing.status
        : 'open';

  const values = {
    phoneHash: contact?.phoneHash ?? existing?.phoneHash ?? null,
    contactId: contact?.contactId ?? existing?.contactId ?? null,
    recipientRegion: contact?.region ?? existing?.recipientRegion ?? null,
    valueMinor: Math.max(0, input.valueMinor),
    currency: input.currency,
    itemSummary: input.itemSummary.slice(0, 200),
    itemCount: input.itemCount,
    consentWording: isKnownConsentWording(input.consentAttribute) ? input.consentAttribute : null,
    status: nextStatus,
    skipReason:
      nextStatus === 'open' || nextStatus === 'completed' ? null : (existing?.skipReason ?? null),
    // A late completion (older timestamp) still completes, but never winds the clock back.
    sourceUpdatedAt:
      existing !== undefined && existing.sourceUpdatedAt > input.updatedAt
        ? existing.sourceUpdatedAt
        : input.updatedAt,
    completedAt: input.completedAt ?? existing?.completedAt ?? null,
  } as const;

  let checkoutId: string;
  if (existing === undefined) {
    checkoutId = newId('checkout');
    await tx.insert(schema.checkouts).values({
      id: checkoutId,
      tenantId: input.tenantId,
      source: input.source,
      externalId: input.externalId,
      sourceCreatedAt: input.createdAt,
      ...values,
    });
  } else {
    checkoutId = existing.id;
    await tx.update(schema.checkouts).set(values).where(eq(schema.checkouts.id, existing.id));
  }

  // Consent is recorded when given (E-13, E-105, E-106): our checkbox only, known wording only.
  let consent: 'granted' | 'revoked' | 'unchanged' | 'unknown_wording' = 'unchanged';
  const phoneHash = values.phoneHash;
  const region = values.recipientRegion ?? input.defaultRegion;
  const attributeLength = input.consentAttribute?.length ?? 0;
  if (input.consentAttribute !== null && values.consentWording === null) {
    consent = 'unknown_wording';
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: 'shopify',
      action: 'consent.unknown_wording',
      targetType: 'checkout',
      targetId: checkoutId,
      after: { attribute_length: attributeLength },
    });
  } else if (phoneHash !== null && isKnownConsentWording(input.consentAttribute)) {
    const granted = await grantOnce(tx, {
      tenantId: input.tenantId,
      phoneHash,
      region,
      wordingVersion: input.consentAttribute,
      externalRef: input.externalId,
      capturedAt: input.updatedAt,
      context: { surface: 'checkout', checkout_id: checkoutId },
    });
    if (granted) consent = 'granted';
  } else if (
    phoneHash !== null &&
    input.consentAttribute === null &&
    existing?.consentWording !== null &&
    existing?.consentWording !== undefined
  ) {
    // The box was ticked on this checkout and is now unticked: that withdraws consent (E-105).
    const n = await revokeConsent(tx, {
      tenantId: input.tenantId,
      phoneHash,
      purpose: 'promotional',
      source: 'checkout',
      recipientRegion: region,
      at: input.updatedAt,
      externalRef: input.externalId,
    });
    if (n > 0) consent = 'revoked';
  }

  // A completed checkout needs no recovery call (E-102).
  let cancelledIntents = 0;
  if (completed && existing?.intentId !== null && existing?.intentId !== undefined) {
    const r = await cancelIntents(tx, {
      tenantId: input.tenantId,
      intentId: existing.intentId,
      reason: 'checkout_completed',
      at: input.now,
      actor: { type: 'shopify' },
    });
    cancelledIntents = r.cancelled.length;
  }

  return { kind: 'recorded', checkoutId, status: nextStatus, consent, cancelledIntents };
}

/** One live grant per (phone, checkout or order, wording): webhook redeliveries add nothing. */
async function grantOnce(
  tx: DbOrTx,
  g: {
    readonly tenantId: string;
    readonly phoneHash: string;
    readonly region: string;
    readonly wordingVersion: string;
    readonly externalRef: string;
    readonly capturedAt: Date;
    readonly context: Readonly<Record<string, string | number | boolean | null>>;
  },
): Promise<boolean> {
  const [already] = await tx
    .select({ id: schema.consents.id })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.tenantId, g.tenantId),
        eq(schema.consents.phoneHash, g.phoneHash),
        eq(schema.consents.action, 'grant'),
        eq(schema.consents.externalRef, g.externalRef),
        eq(schema.consents.wordingVersion, g.wordingVersion),
        sql`not exists (select 1 from consents r where r.action = 'revoke' and r.grant_id = ${schema.consents.id})`,
      ),
    )
    .limit(1);
  if (already !== undefined) return false;
  await recordConsent(tx, {
    tenantId: g.tenantId,
    phoneHash: g.phoneHash,
    purpose: 'promotional',
    source: 'checkout',
    recipientRegion: g.region,
    capturedAt: g.capturedAt,
    wordingVersion: g.wordingVersion,
    externalRef: g.externalRef,
    context: g.context,
  });
  return true;
}

/**
 * The same checkbox, seen on an ORDER (the cart block's attribute carries into the order; a
 * one-click checkout sends no checkout webhooks at all, E-14). COD orders record it through
 * `createIntent`; every other order comes here. Known wording only (E-106).
 */
export async function recordOrderConsent(
  tx: DbOrTx,
  keys: PhoneKeys,
  input: {
    readonly tenantId: string;
    readonly rawPhone: string | null;
    readonly defaultRegion: PhoneRegion;
    readonly consentAttribute: string | null;
    readonly externalOrderId: string;
    readonly placedAt: Date;
    readonly now: Date;
  },
): Promise<'granted' | 'unchanged' | 'unknown_wording' | 'no_phone'> {
  const attribute = input.consentAttribute;
  if (attribute === null) return 'unchanged';
  const attributeLength = attribute.length;
  if (!isKnownConsentWording(attribute)) {
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: 'shopify',
      action: 'consent.unknown_wording',
      targetType: 'order',
      targetId: input.externalOrderId,
      after: { attribute_length: attributeLength },
    });
    return 'unknown_wording';
  }
  if (input.rawPhone === null || input.rawPhone.trim().length === 0) return 'no_phone';
  const c = await upsertContact(tx, keys, {
    tenantId: input.tenantId,
    rawPhone: input.rawPhone,
    defaultRegion: input.defaultRegion,
    source: 'shopify:order',
    at: input.now,
  });
  if (!c.ok || c.erased) return 'no_phone';
  const granted = await grantOnce(tx, {
    tenantId: input.tenantId,
    phoneHash: c.phoneHash,
    region: c.phone.region,
    wordingVersion: attribute,
    externalRef: input.externalOrderId,
    capturedAt: input.placedAt,
    context: { surface: 'order' },
  });
  return granted ? 'granted' : 'unchanged';
}

/**
 * An order arrived: every open or scheduled checkout from the same phone (or with this
 * checkout token) created in the last 24 h is converted, and its pending recovery call
 * cancelled (E-102, E-103 — a live call is superseded by cancelIntents).
 */
export async function convertCheckouts(
  tx: DbOrTx,
  input: {
    readonly tenantId: string;
    /** The order row, when there is one (an API cart may be closed without one). */
    readonly orderId: string | null;
    readonly phoneHash: string | null;
    readonly checkoutToken: string | null;
    /**
     * Which platform the token belongs to. A token matches only within its own source: two
     * platforms could otherwise collide on the same reference (E-139).
     */
    readonly source?: CheckoutSource;
    readonly placedAt: Date;
    readonly now: Date;
  },
): Promise<{ converted: number; cancelledIntents: number }> {
  const since = addMinutes(input.placedAt, -ABANDONED_CART_MAX_AGE_HOURS * 60);
  const matches = [];
  if (input.checkoutToken !== null)
    matches.push(
      input.source === undefined
        ? eq(schema.checkouts.externalId, input.checkoutToken)
        : and(
            eq(schema.checkouts.source, input.source),
            eq(schema.checkouts.externalId, input.checkoutToken),
          ),
    );
  if (input.phoneHash !== null)
    matches.push(
      and(
        eq(schema.checkouts.phoneHash, input.phoneHash),
        gt(schema.checkouts.sourceCreatedAt, since),
      ),
    );
  if (matches.length === 0) return { converted: 0, cancelledIntents: 0 };
  const rows = await tx
    .update(schema.checkouts)
    .set({
      status: 'converted',
      ...(input.orderId === null ? {} : { orderId: input.orderId }),
      skipReason: null,
    })
    .where(
      and(
        eq(schema.checkouts.tenantId, input.tenantId),
        inArray(schema.checkouts.status, ['open', 'skipped', 'scheduled']),
        lte(schema.checkouts.sourceCreatedAt, input.placedAt),
        sql`(${sql.join(matches, sql` or `)})`,
      ),
    )
    .returning({ id: schema.checkouts.id, intentId: schema.checkouts.intentId });
  let cancelledIntents = 0;
  for (const r of rows) {
    if (r.intentId === null) continue;
    const c = await cancelIntents(tx, {
      tenantId: input.tenantId,
      intentId: r.intentId,
      reason: 'order_placed',
      at: input.now,
      actor: { type: 'shopify' },
    });
    cancelledIntents += c.cancelled.length + c.flaggedLive.length;
  }
  return { converted: rows.length, cancelledIntents };
}

export interface SweepReport {
  readonly considered: number;
  readonly scheduled: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly expired: number;
  readonly converted: number;
}

/**
 * The sweep (reconcile worker, every minute). Cross-tenant candidates are listed with the
 * SERVICE role; each checkout is then decided inside its tenant's transaction on the APP role,
 * where RLS applies and `for update skip locked` keeps two reconcile instances apart.
 */
export async function sweepAbandonedCheckouts(
  service: Db,
  app: Db,
  keys: PhoneKeys,
  now: Date,
  limit = 200,
): Promise<SweepReport> {
  const idleBefore = addMinutes(now, -ABANDONED_CART_IDLE_MINUTES);
  const candidates = await service
    .select({ id: schema.checkouts.id, tenantId: schema.checkouts.tenantId })
    .from(schema.checkouts)
    .where(
      and(
        eq(schema.checkouts.status, 'open'),
        lte(schema.checkouts.sourceUpdatedAt, idleBefore),
        isNull(schema.checkouts.erasedAt),
      ),
    )
    .orderBy(schema.checkouts.sourceUpdatedAt)
    .limit(limit);

  const report = {
    considered: candidates.length,
    scheduled: 0,
    skipped: {} as Record<string, number>,
    expired: 0,
    converted: 0,
  };
  for (const c of candidates) {
    const decision = await withTenant(app, c.tenantId, (tx) => decideCheckout(tx, keys, c.id, now));
    if (decision === 'scheduled') report.scheduled += 1;
    else if (decision === 'expired') report.expired += 1;
    else if (decision === 'converted') report.converted += 1;
    else if (decision !== 'locked') report.skipped[decision] = (report.skipped[decision] ?? 0) + 1;
  }
  return report;
}

/** 'scheduled' | 'expired' | 'converted' | 'locked', or the skip reason. */
type Decision = string;

async function decideCheckout(
  tx: DbOrTx,
  keys: PhoneKeys,
  checkoutId: string,
  now: Date,
): Promise<Decision> {
  const [c] = await tx
    .select()
    .from(schema.checkouts)
    .where(and(eq(schema.checkouts.id, checkoutId), eq(schema.checkouts.status, 'open')))
    .for('update', { skipLocked: true })
    .limit(1);
  if (c === undefined) return 'locked';

  const skip = async (reason: string): Promise<Decision> => {
    await tx
      .update(schema.checkouts)
      .set({ status: 'skipped', skipReason: reason, sweptAt: now })
      .where(eq(schema.checkouts.id, c.id));
    return reason;
  };

  // E-110: older than 24 h — the intent would already be past its deadline.
  if (c.sourceCreatedAt <= addMinutes(now, -ABANDONED_CART_MAX_AGE_HOURS * 60)) {
    await tx
      .update(schema.checkouts)
      .set({ status: 'expired', sweptAt: now })
      .where(eq(schema.checkouts.id, c.id));
    return 'expired';
  }
  if (c.phoneHash === null || c.contactId === null) return skip('no_phone');

  // E-102: an order from this phone (or this checkout) after the checkout started.
  const [order] = await tx
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.tenantId, c.tenantId),
        sql`(${schema.orders.phoneHash} = ${c.phoneHash} or ${schema.orders.checkoutToken} = ${c.externalId})`,
        sql`${schema.orders.placedAt} >= ${c.sourceCreatedAt}`,
      ),
    )
    .limit(1);
  if (order !== undefined) {
    await tx
      .update(schema.checkouts)
      .set({ status: 'converted', orderId: order.id, sweptAt: now })
      .where(eq(schema.checkouts.id, c.id));
    return 'converted';
  }

  // Invariant 5: no live promotional grant → never an intent (the gate would refuse anyway;
  // this keeps thousands of unconsented checkouts out of the merchant's call list). E-107.
  const [grant] = await tx
    .select({ id: schema.consents.id })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.tenantId, c.tenantId),
        eq(schema.consents.phoneHash, c.phoneHash),
        eq(schema.consents.action, 'grant'),
        inArray(schema.consents.purpose, ['promotional', 'all']),
        sql`(${schema.consents.expiresAt} is null or ${schema.consents.expiresAt} > ${now})`,
        sql`not exists (select 1 from consents r where r.action = 'revoke' and r.grant_id = ${schema.consents.id})`,
      ),
    )
    .limit(1);
  if (grant === undefined) return skip('consent:missing');

  // E-108: one recovery call per phone per week — do not even queue a second.
  const [recent] = await tx
    .select({ id: schema.callIntents.id })
    .from(schema.callIntents)
    .where(
      and(
        eq(schema.callIntents.tenantId, c.tenantId),
        eq(schema.callIntents.phoneHash, c.phoneHash),
        eq(schema.callIntents.purpose, 'promotional'),
        gt(schema.callIntents.createdAt, addMinutes(now, -PROMOTIONAL_COOLDOWN_DAYS * 24 * 60)),
        inArray(schema.callIntents.status, [
          'SCHEDULED',
          'RETRY_SCHEDULED',
          'DISPATCHING',
          'IN_PROGRESS',
          'COMPLETED',
          'EXHAUSTED',
        ]),
      ),
    )
    .orderBy(desc(schema.callIntents.createdAt))
    .limit(1);
  if (recent !== undefined) return skip('recently_called');

  const [contactRow] = await tx
    .select({ name: schema.contacts.name, erasedAt: schema.contacts.erasedAt })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, c.contactId))
    .limit(1);
  const [tenant] = await tx
    .select({ name: schema.tenants.name })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, c.tenantId))
    .limit(1);

  const result = await createIntent(tx, keys, {
    tenantId: c.tenantId,
    useCase: 'abandoned_cart',
    source: intentSourceFor(c.source),
    account: `${c.source}:checkout`,
    externalRef: c.externalId,
    // The 24-hour deadline runs from when the cart was started, never from the sweep (E-101).
    eventTs: c.sourceCreatedAt,
    rawPhone: null,
    defaultRegion: (c.recipientRegion ?? 'IN') as PhoneRegion,
    existingContact: {
      contactId: c.contactId,
      phoneHash: c.phoneHash,
      region: c.recipientRegion ?? 'IN',
      erased: contactRow?.erasedAt !== null && contactRow?.erasedAt !== undefined,
    },
    variables: {
      customer_name: contactRow?.name ?? '',
      brand: tenant?.name ?? '',
      cart_summary: c.itemSummary,
      cart_value: (c.valueMinor / 100).toFixed(0),
      currency: c.currency,
      item_count: c.itemCount,
    },
    valuePaise: c.valueMinor,
    currency: c.currency,
    now,
    actor: { type: 'worker', id: 'checkout-sweep' },
  });

  if (result.status === 'skipped') return skip(result.reason);
  // The same cart already had its one intent (skipped, reopened, swept again): never a second call.
  if (result.status === 'duplicate') return skip('already_handled');
  const intentId = 'intentId' in result ? result.intentId : null;
  await tx
    .update(schema.checkouts)
    .set({
      status: result.status === 'gated' ? 'skipped' : 'scheduled',
      skipReason: result.status === 'gated' ? result.reason : null,
      intentId,
      sweptAt: now,
    })
    .where(eq(schema.checkouts.id, c.id));
  return result.status === 'gated' ? result.reason : 'scheduled';
}

/** Erasure / shop redact / retention: the checkout keeps its counts, loses the person (E-119). */
export async function eraseCheckouts(
  tx: DbOrTx,
  tenantId: string,
  where: { readonly phoneHash: string } | { readonly all: true } | { readonly before: Date },
  at: Date,
): Promise<number> {
  const scope =
    'phoneHash' in where
      ? eq(schema.checkouts.phoneHash, where.phoneHash)
      : 'before' in where
        ? lte(schema.checkouts.sourceCreatedAt, where.before)
        : sql`true`;
  const rows = await tx
    .update(schema.checkouts)
    .set({ phoneHash: null, contactId: null, erasedAt: at, itemSummary: '' })
    .where(and(eq(schema.checkouts.tenantId, tenantId), isNull(schema.checkouts.erasedAt), scope))
    .returning({ id: schema.checkouts.id });
  return rows.length;
}

export const CHECKOUT_OPEN_STATUSES = OPEN_LIKE;
