import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import {
  GATE_REASONS,
  USE_CASE_WINDOWS,
  recordConsent,
  type GateReason,
} from '@naaradh/compliance';
import { sanitiseVariables, type UseCase } from '@naaradh/scripts';
import { addMinutes, newId, type PhoneRegion } from '@naaradh/shared';
import { z } from 'zod';
import { audit } from './audit.js';
import { placeholderContact, upsertContact, type PhoneKeys } from './contacts.js';
import { emitMerchantEvent } from './outbox.js';

/**
 * Intent creation (AGENTS §5.1). One function for every source — Shopify, API, WooCommerce
 * later — so the rules live once:
 *
 *   idempotency on (source, account, ref, use case)              E-52
 *   event_ts from the SOURCE, envelope from the use case         invariant 4
 *   test/staff orders skipped                                    E-46
 *   value thresholds                                             E-47
 *   several orders from one phone inside 30 min → one call       E-42
 *   variables sanitised and allow-listed                         E-72
 *   missing/invalid number → a GATED intent the merchant can see E-43, E-26
 */

export const UseCaseConfig = z
  .object({
    defaultLocale: z.string().default('hi-IN'),
    minOrderValuePaise: z.number().int().min(0).default(0),
    /** Above this, the merchant wants a human: the variables carry high_value=yes for the script. */
    humanAbovePaise: z.number().int().positive().nullable().default(null),
    /** Rollout percentage (P1-SHOP-3 pilot): deterministic on the external ref. */
    pilotPercent: z.number().int().min(0).max(100).default(100),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .passthrough();

export type IntentSource = (typeof schema.intentSource.enumValues)[number];
export type ConsentSourceValue = (typeof schema.consentSource.enumValues)[number];

export interface CreateIntentInput {
  readonly tenantId: string;
  readonly useCase: UseCase;
  readonly source: IntentSource;
  /** Account the ref belongs to (shop domain, api key id) — part of the idempotency key. */
  readonly account: string;
  readonly externalRef: string;
  readonly eventTs: Date;
  readonly rawPhone: string | null;
  readonly defaultRegion: PhoneRegion;
  readonly customerName?: string | null;
  readonly timezone?: string | null;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly valuePaise?: number | null;
  readonly currency?: string | null;
  readonly locale?: string | null;
  readonly campaignId?: string | null;
  /** E-46 signals from the source. */
  readonly isTest?: boolean;
  readonly tags?: readonly string[];
  readonly customerTags?: readonly string[];
  /** Consent captured with this event (checkout checkbox, form tick). */
  readonly consent?: {
    readonly purpose: 'service' | 'promotional' | 'all';
    readonly source: ConsentSourceValue;
    readonly wordingVersion?: string | undefined;
    readonly evidenceUri?: string | undefined;
  };
  /** For appointment use cases: the envelope is relative to this instant. */
  readonly appointmentTs?: Date | null;
  readonly now: Date;
  readonly actor: { type: 'worker' | 'api_key' | 'user' | 'shopify'; id?: string };
}

export type SkipReason =
  | 'use_case_disabled'
  | 'test_order'
  | 'staff_customer'
  | 'skip_tag'
  | 'below_min_value'
  | 'pilot_excluded'
  | 'no_use_case';

export type CreateIntentResult =
  | { status: 'scheduled'; intentId: string; notBefore: Date; notAfter: Date }
  | { status: 'merged'; intentId: string }
  | { status: 'gated'; intentId: string; reason: GateReason }
  | { status: 'duplicate'; intentId: string }
  | { status: 'skipped'; reason: SkipReason };

const PRIORITY_BY_USE_CASE: Readonly<Record<UseCase, number>> = {
  cod_confirm: 100,
  delivery_reschedule: 90,
  lead_callback: 80,
  appointment_confirm: 60,
  appointment_book: 60,
  inbound_support: 50,
  abandoned_cart: 10,
  feedback: 5,
  reactivation: 5,
};

export function idempotencyKeyFor(
  source: string,
  account: string,
  externalRef: string,
  useCase: string,
): string {
  return `${source}:${account}:${externalRef}:${useCase}`;
}

/** Deterministic pilot bucketing (FNV-1a): the same order always lands in the same bucket. */
export function pilotBucket(externalRef: string): number {
  let h = 2166136261;
  for (const ch of externalRef) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 100;
}

interface ResolvedContact {
  readonly contactId: string;
  readonly phoneHash: string;
  readonly region: string;
  readonly gatedReason: GateReason | null;
}

async function resolveContact(
  tx: DbOrTx,
  keys: PhoneKeys,
  input: CreateIntentInput,
  idempotencyKey: string,
  locale: string,
): Promise<ResolvedContact> {
  if (input.rawPhone === null || input.rawPhone.trim().length === 0) {
    const p = await placeholderContact(
      tx,
      keys,
      input.tenantId,
      `missing:${idempotencyKey}`,
      input.defaultRegion,
    );
    return { ...p, region: input.defaultRegion, gatedReason: 'number:missing' };
  }
  const c = await upsertContact(tx, keys, {
    tenantId: input.tenantId,
    rawPhone: input.rawPhone,
    defaultRegion: input.defaultRegion,
    name: input.customerName ?? null,
    timezone: input.timezone ?? null,
    localeHint: locale,
    source: input.source,
    at: input.now,
  });
  if (!c.ok) {
    const p = await placeholderContact(
      tx,
      keys,
      input.tenantId,
      `invalid:${idempotencyKey}`,
      input.defaultRegion,
    );
    return { ...p, region: input.defaultRegion, gatedReason: 'number:invalid' };
  }
  return {
    contactId: c.contactId,
    phoneHash: c.phoneHash,
    region: c.phone.region,
    gatedReason: c.erased ? 'contact:erased' : null,
  };
}

export async function createIntent(
  tx: DbOrTx,
  keys: PhoneKeys,
  input: CreateIntentInput,
): Promise<CreateIntentResult> {
  const [useCaseRow] = await tx
    .select({
      id: schema.useCases.id,
      purpose: schema.useCases.purpose,
      enabled: schema.useCases.enabled,
      config: schema.useCases.config,
    })
    .from(schema.useCases)
    .where(
      and(eq(schema.useCases.tenantId, input.tenantId), eq(schema.useCases.kind, input.useCase)),
    )
    .limit(1);
  if (useCaseRow === undefined) return { status: 'skipped', reason: 'no_use_case' };
  if (!useCaseRow.enabled) return { status: 'skipped', reason: 'use_case_disabled' };
  const config = UseCaseConfig.parse(useCaseRow.config);

  // E-46
  if (input.isTest === true) return { status: 'skipped', reason: 'test_order' };
  const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((t) => t.toLowerCase());
  if (lower(input.tags).includes('naaradh:skip')) return { status: 'skipped', reason: 'skip_tag' };
  if (lower(input.customerTags).some((t) => t === 'staff' || t === 'naaradh:skip'))
    return { status: 'skipped', reason: 'staff_customer' };
  // E-47 lower bound. The upper bound flags the variables; the script routes to a human.
  if (
    input.valuePaise !== undefined &&
    input.valuePaise !== null &&
    input.valuePaise < config.minOrderValuePaise
  ) {
    return { status: 'skipped', reason: 'below_min_value' };
  }
  if (config.pilotPercent < 100 && pilotBucket(input.externalRef) >= config.pilotPercent)
    return { status: 'skipped', reason: 'pilot_excluded' };

  const idempotencyKey = idempotencyKeyFor(
    input.source,
    input.account,
    input.externalRef,
    input.useCase,
  );

  // E-52: the same event twice → audited, never a second intent.
  const [dup] = await tx
    .select({ id: schema.callIntents.id })
    .from(schema.callIntents)
    .where(eq(schema.callIntents.idempotencyKey, idempotencyKey))
    .limit(1);
  if (dup !== undefined) {
    await audit(tx, {
      tenantId: input.tenantId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'intent.duplicate_event',
      targetType: 'call_intent',
      targetId: dup.id,
      after: { idempotency_key: idempotencyKey },
    });
    return { status: 'duplicate', intentId: dup.id };
  }

  // Envelope (invariant 4): from the SOURCE timestamp, never now().
  const window = (
    USE_CASE_WINDOWS as Record<
      string,
      { notBeforeMinutes: number; notAfterMinutes: number } | undefined
    >
  )[input.useCase];
  const anchor = input.useCase.startsWith('appointment')
    ? (input.appointmentTs ?? input.eventTs)
    : input.eventTs;
  const notBefore = addMinutes(anchor, window?.notBeforeMinutes ?? 2);
  const notAfter = addMinutes(anchor, window?.notAfterMinutes ?? 24 * 60);
  const locale = input.locale ?? config.defaultLocale;
  const priority = config.priority ?? PRIORITY_BY_USE_CASE[input.useCase];

  // E-72
  const sanitised = sanitiseVariables(input.useCase, input.variables);
  const variables: Record<string, string> = { ...sanitised.variables };
  if (
    config.humanAbovePaise !== null &&
    input.valuePaise !== undefined &&
    input.valuePaise !== null &&
    input.valuePaise > config.humanAbovePaise
  ) {
    variables['high_value'] = 'yes';
  }

  const contact = await resolveContact(tx, keys, input, idempotencyKey, locale);

  const row = (
    id: string,
    overrides: Partial<typeof schema.callIntents.$inferInsert> = {},
  ): typeof schema.callIntents.$inferInsert => ({
    id,
    tenantId: input.tenantId,
    useCaseId: useCaseRow.id,
    useCase: input.useCase,
    purpose: useCaseRow.purpose,
    direction: 'outbound',
    contactId: contact.contactId,
    phoneHash: contact.phoneHash,
    recipientRegion: contact.region,
    source: input.source,
    externalRef: input.externalRef,
    externalRefs: [input.externalRef],
    campaignId: input.campaignId ?? null,
    eventTs: input.eventTs,
    notBefore,
    notAfter,
    priority,
    status: 'SCHEDULED',
    variables,
    locale,
    nextAttemptAt: notBefore,
    idempotencyKey,
    valuePaise: input.valuePaise ?? null,
    currency: input.currency ?? null,
    ...overrides,
  });

  // Consent captured with the event (checkout checkbox → ledger, E-13).
  if (input.consent !== undefined && contact.gatedReason === null) {
    await recordConsent(tx, {
      tenantId: input.tenantId,
      phoneHash: contact.phoneHash,
      purpose: input.consent.purpose,
      source: input.consent.source,
      recipientRegion: contact.region,
      capturedAt: input.eventTs,
      wordingVersion: input.consent.wordingVersion,
      evidenceUri: input.consent.evidenceUri,
      externalRef: input.externalRef,
    });
  }

  // E-42: same phone, same use case, still waiting, events within 30 minutes → one call.
  if (contact.gatedReason === null) {
    const [open] = await tx
      .select({ id: schema.callIntents.id, refs: schema.callIntents.externalRefs })
      .from(schema.callIntents)
      .where(
        and(
          eq(schema.callIntents.tenantId, input.tenantId),
          eq(schema.callIntents.phoneHash, contact.phoneHash),
          eq(schema.callIntents.useCase, input.useCase),
          inArray(schema.callIntents.status, ['SCHEDULED', 'RETRY_SCHEDULED']),
          gt(schema.callIntents.eventTs, addMinutes(input.eventTs, -30)),
        ),
      )
      .limit(1);
    if (open !== undefined && !open.refs.includes(input.externalRef)) {
      await tx
        .update(schema.callIntents)
        .set({
          externalRefs: sql`array_append(${schema.callIntents.externalRefs}, ${input.externalRef})`,
          variables: sql`${schema.callIntents.variables} || ${JSON.stringify({ merged_orders: 'yes' })}::jsonb`,
        })
        .where(eq(schema.callIntents.id, open.id));
      // The merged event keeps its own idempotency row (as a tombstone) so a redelivery is a duplicate.
      await tx.insert(schema.callIntents).values(
        row(newId('intent'), {
          status: 'CANCELLED',
          cancelReason: `merged_into:${open.id}`,
          cancelledAt: input.now,
          nextAttemptAt: null,
        }),
      );
      await audit(tx, {
        tenantId: input.tenantId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'intent.merged',
        targetType: 'call_intent',
        targetId: open.id,
        after: { external_ref: input.externalRef },
      });
      return { status: 'merged', intentId: open.id };
    }
  }

  const id = newId('intent');
  const gated = contact.gatedReason;
  await tx.insert(schema.callIntents).values(
    row(id, {
      status: gated === null ? 'SCHEDULED' : 'GATED',
      gatedReason: gated,
      nextAttemptAt: gated === null ? notBefore : null,
      gateTrace:
        gated === null
          ? null
          : {
              at: input.now.toISOString(),
              engine: null,
              steps: [{ step: 4, name: 'number', ok: false, reason: gated, ms: 0 }],
            },
    }),
  );

  await audit(tx, {
    tenantId: input.tenantId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: gated === null ? 'intent.created' : 'intent.gated',
    targetType: 'call_intent',
    targetId: id,
    after: {
      use_case: input.useCase,
      source: input.source,
      external_ref: input.externalRef,
      status: gated === null ? 'SCHEDULED' : 'GATED',
      gated_reason: gated,
      suspicious_variables: sanitised.suspicious,
      dropped_variables: sanitised.dropped,
    },
  });

  if (gated === null) {
    await emitMerchantEvent(tx, input.tenantId, {
      type: 'intent.scheduled',
      eventId: `${id}:scheduled`,
      at: input.now,
      data: {
        intent_id: id,
        use_case: input.useCase,
        external_ref: input.externalRef,
        not_before: notBefore.toISOString(),
        not_after: notAfter.toISOString(),
      },
    });
    return { status: 'scheduled', intentId: id, notBefore, notAfter };
  }
  await emitMerchantEvent(tx, input.tenantId, {
    type: 'intent.gated',
    eventId: `${id}:gated`,
    at: input.now,
    data: {
      intent_id: id,
      use_case: input.useCase,
      external_ref: input.externalRef,
      reason: gated,
      explanation: GATE_REASONS[gated].explanation,
      hint: GATE_REASONS[gated].hint,
    },
  });
  return { status: 'gated', intentId: id, reason: gated };
}
