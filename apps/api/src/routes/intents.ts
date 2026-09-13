import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withTenant, type Db } from '@naaradh/db';
import { GATE_REASONS, type GateReason } from '@naaradh/compliance';
import { cancelIntents, createIntent, type PhoneKeys } from '@naaradh/pipeline';
import { USE_CASES } from '@naaradh/scripts';
import { NaaradhError } from '@naaradh/shared';
import type { Redis } from 'ioredis';
import { consumeDailyCap, requireScope } from '../auth.js';

/**
 * POST /v1/intents, GET /v1/intents/:id, POST /v1/intents/:id/cancel (SPEC §9.1).
 * The request is validated at the boundary; everything after goes through the same
 * createIntent() the Shopify path uses, so the API can never bypass a rule.
 */
export const CreateIntentBody = z.object({
  use_case: z.enum(USE_CASES),
  /** Any format the merchant has; normalised here, never stored as sent. */
  phone: z.string().min(5).max(32),
  /** Merchant's country, used only to interpret a number without a country code. */
  phone_region: z.string().length(2).default('IN'),
  name: z.string().max(120).optional(),
  external_ref: z.string().min(1).max(200),
  /** When the customer acted (form submitted, order placed). Defaults to now; never in the future. */
  event_ts: z.string().datetime({ offset: true }).optional(),
  appointment_ts: z.string().datetime({ offset: true }).optional(),
  variables: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  locale: z
    .string()
    .regex(/^[a-z]{2}-[A-Z]{2}$/)
    .optional(),
  timezone: z.string().max(64).optional(),
  value_minor: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  consent: z
    .object({
      purpose: z.enum(['service', 'promotional', 'all']),
      source: z.enum(['form', 'form_written', 'api', 'verbal', 'checkout', 'checkout_written']),
      wording_version: z.string().max(64).optional(),
      evidence_uri: z.string().url().optional(),
    })
    .optional(),
});

export interface IntentRouteDeps {
  readonly db: Db;
  readonly redis: Redis;
  readonly keys: PhoneKeys;
  readonly clock: () => Date;
}

export function registerIntentRoutes(app: FastifyInstance, deps: IntentRouteDeps): void {
  app.post('/v1/intents', async (request, reply) => {
    const auth = requireScope(request, 'intents:create');
    const body = CreateIntentBody.parse(request.body);
    const now = deps.clock();
    const eventTs = body.event_ts === undefined ? now : new Date(body.event_ts);
    if (eventTs.getTime() > now.getTime() + 60_000)
      throw new NaaradhError('VALIDATION_FAILED', 'event_ts is in the future');
    // Public site keys may only start the customer-requested use case (SPEC §9.2).
    if (auth.kind === 'public' && body.use_case !== 'lead_callback')
      throw new NaaradhError('FORBIDDEN', 'public keys may only create lead_callback intents');

    await consumeDailyCap(deps.redis, auth, now);

    const result = await withTenant(deps.db, auth.tenantId, (tx) =>
      createIntent(tx, deps.keys, {
        tenantId: auth.tenantId,
        useCase: body.use_case,
        source: 'api',
        account: auth.apiKeyId,
        externalRef: body.external_ref,
        eventTs,
        rawPhone: body.phone,
        defaultRegion: body.phone_region.toUpperCase() as 'IN',
        customerName: body.name ?? null,
        timezone: body.timezone ?? null,
        variables: { customer_name: body.name ?? '', ...body.variables },
        valuePaise: body.value_minor ?? null,
        currency: body.currency ?? null,
        locale: body.locale ?? null,
        ...(body.consent === undefined
          ? {}
          : {
              consent: {
                purpose: body.consent.purpose,
                source: body.consent.source,
                wordingVersion: body.consent.wording_version,
                evidenceUri: body.consent.evidence_uri,
              },
            }),
        appointmentTs: body.appointment_ts === undefined ? null : new Date(body.appointment_ts),
        now,
        actor: { type: 'api_key', id: auth.apiKeyId },
      }),
    );

    switch (result.status) {
      case 'scheduled':
        return reply.code(202).send({
          intent_id: result.intentId,
          status: 'scheduled',
          not_before: result.notBefore.toISOString(),
          not_after: result.notAfter.toISOString(),
        });
      case 'merged':
        return reply.code(202).send({ intent_id: result.intentId, status: 'merged' });
      case 'duplicate':
        return reply.code(200).send({ intent_id: result.intentId, status: 'duplicate' });
      case 'gated':
        return reply.code(202).send({
          intent_id: result.intentId,
          status: 'gated',
          reason: result.reason,
          ...explain(result.reason),
        });
      case 'skipped':
        return reply.code(200).send({ intent_id: null, status: 'skipped', reason: result.reason });
    }
  });

  app.get<{ Params: { id: string } }>('/v1/intents/:id', async (request) => {
    const auth = requireScope(request, 'intents:read');
    const view = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const [intent] = await tx
        .select({
          id: schema.callIntents.id,
          useCase: schema.callIntents.useCase,
          status: schema.callIntents.status,
          externalRefs: schema.callIntents.externalRefs,
          eventTs: schema.callIntents.eventTs,
          notBefore: schema.callIntents.notBefore,
          notAfter: schema.callIntents.notAfter,
          nextAttemptAt: schema.callIntents.nextAttemptAt,
          gatedReason: schema.callIntents.gatedReason,
          attemptsCount: schema.callIntents.attemptsCount,
          cancelledAt: schema.callIntents.cancelledAt,
          contactId: schema.callIntents.contactId,
          createdAt: schema.callIntents.createdAt,
        })
        .from(schema.callIntents)
        .where(
          and(
            eq(schema.callIntents.tenantId, auth.tenantId),
            eq(schema.callIntents.id, request.params.id),
          ),
        )
        .limit(1);
      if (intent === undefined) return null;
      const [contact] = await tx
        .select({ masked: schema.contacts.phoneMasked })
        .from(schema.contacts)
        .where(eq(schema.contacts.id, intent.contactId))
        .limit(1);
      const attempts = await tx
        .select({
          id: schema.callAttempts.id,
          attemptNo: schema.callAttempts.attemptNo,
          status: schema.callAttempts.status,
          dispatchedAt: schema.callAttempts.dispatchedAt,
          answeredAt: schema.callAttempts.answeredAt,
          endedAt: schema.callAttempts.endedAt,
          answeredBy: schema.callAttempts.answeredBy,
          endReason: schema.callAttempts.endReason,
          durationSec: schema.callAttempts.durationSec,
          recordingUri: schema.callAttempts.recordingUri,
        })
        .from(schema.callAttempts)
        .where(eq(schema.callAttempts.intentId, intent.id))
        .orderBy(schema.callAttempts.attemptNo);
      const [outcome] = await tx
        .select({
          id: schema.callOutcomes.id,
          outcome: schema.callOutcomes.outcome,
          confidence: schema.callOutcomes.confidence,
          billable: schema.callOutcomes.billable,
          extracted: schema.callOutcomes.extracted,
          superseded: schema.callOutcomes.superseded,
          createdAt: schema.callOutcomes.createdAt,
        })
        .from(schema.callOutcomes)
        .where(eq(schema.callOutcomes.intentId, intent.id))
        .orderBy(desc(schema.callOutcomes.createdAt))
        .limit(1);
      return {
        intent_id: intent.id,
        use_case: intent.useCase,
        status: intent.status.toLowerCase(),
        external_refs: intent.externalRefs,
        phone_masked: contact?.masked ?? null,
        event_ts: intent.eventTs.toISOString(),
        not_before: intent.notBefore.toISOString(),
        not_after: intent.notAfter.toISOString(),
        next_attempt_at: intent.nextAttemptAt?.toISOString() ?? null,
        attempts_count: intent.attemptsCount,
        cancelled_at: intent.cancelledAt?.toISOString() ?? null,
        gated:
          intent.gatedReason === null
            ? null
            : { reason: intent.gatedReason, ...explain(intent.gatedReason as GateReason) },
        attempts: attempts.map((a) => ({
          attempt_id: a.id,
          attempt_no: a.attemptNo,
          status: a.status.toLowerCase(),
          dispatched_at: a.dispatchedAt?.toISOString() ?? null,
          answered_at: a.answeredAt?.toISOString() ?? null,
          ended_at: a.endedAt?.toISOString() ?? null,
          answered_by: a.answeredBy,
          end_reason: a.endReason,
          duration_sec: a.durationSec,
          recording: a.recordingUri === null ? null : `/v1/calls/${a.id}/recording`,
        })),
        outcome:
          outcome === undefined
            ? null
            : {
                outcome_id: outcome.id,
                outcome: outcome.outcome,
                confidence: Number(outcome.confidence),
                billable: outcome.billable,
                superseded: outcome.superseded,
                extracted: outcome.extracted,
                at: outcome.createdAt.toISOString(),
              },
        created_at: intent.createdAt.toISOString(),
      };
    });
    if (view === null) throw new NaaradhError('NOT_FOUND', 'intent not found');
    return view;
  });

  app.post<{ Params: { id: string } }>('/v1/intents/:id/cancel', async (request, reply) => {
    const auth = requireScope(request, 'intents:create');
    const now = deps.clock();
    const r = await withTenant(deps.db, auth.tenantId, (tx) =>
      cancelIntents(tx, {
        tenantId: auth.tenantId,
        intentId: request.params.id,
        reason: 'api:cancel',
        at: now,
        actor: { type: 'api_key', id: auth.apiKeyId },
      }),
    );
    if (r.cancelled.length === 0 && r.flaggedLive.length === 0) {
      const exists = await withTenant(
        deps.db,
        auth.tenantId,
        async (tx) =>
          (
            await tx
              .select({ id: schema.callIntents.id, status: schema.callIntents.status })
              .from(schema.callIntents)
              .where(eq(schema.callIntents.id, request.params.id))
              .limit(1)
          )[0] ?? null,
      );
      if (exists === null) throw new NaaradhError('NOT_FOUND', 'intent not found');
      return reply.code(200).send({
        intent_id: request.params.id,
        status: exists.status.toLowerCase(),
        cancelled: false,
      });
    }
    return reply.code(200).send({
      intent_id: request.params.id,
      status: r.cancelled.length > 0 ? 'cancelled' : 'cancel_requested',
      cancelled: true,
    });
  });
}

function explain(reason: GateReason): { title: string; explanation: string; hint: string } {
  const info = GATE_REASONS[reason];
  return { title: info.title, explanation: info.explanation, hint: info.hint };
}
