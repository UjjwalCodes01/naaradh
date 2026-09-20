import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, type Db } from '@naaradh/db';
import { recordConsent, revokeConsent, suppress } from '@naaradh/compliance';
import { audit, emitMerchantEvent, type PhoneKeys } from '@naaradh/pipeline';
import { NaaradhError, hashPhone, normalizePhone } from '@naaradh/shared';
import { requireScope } from '../auth.js';

/**
 * POST /v1/consents, DELETE /v1/consents, POST /v1/suppressions (SPEC §9.1).
 * Phone numbers arrive here and leave as hashes; nothing in these routes stores a number.
 */
export const ConsentBody = z.object({
  phone: z.string().min(5).max(32),
  phone_region: z.string().length(2).default('IN'),
  purpose: z.enum(['service', 'promotional', 'all']),
  source: z.enum([
    'form',
    'form_written',
    'api',
    'verbal',
    'checkout',
    'checkout_written',
    'attestation',
  ]),
  wording_version: z.string().max(64).optional(),
  evidence_uri: z.string().url().optional(),
  captured_at: z.string().datetime({ offset: true }).optional(),
  external_ref: z.string().max(200).optional(),
});

export const RevokeBody = z.object({
  phone: z.string().min(5).max(32),
  phone_region: z.string().length(2).default('IN'),
  purpose: z.enum(['service', 'promotional', 'all']).default('all'),
});

export const SuppressionBody = z.object({
  phone: z.string().min(5).max(32),
  phone_region: z.string().length(2).default('IN'),
  purpose: z.enum(['transactional', 'service', 'promotional', 'all']).default('all'),
  reason: z.enum(['opt_out', 'manual', 'wrong_number', 'invalid']).default('opt_out'),
  external_ref: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
});

export interface ConsentRouteDeps {
  readonly db: Db;
  readonly keys: PhoneKeys;
  readonly clock: () => Date;
}

function toHash(
  keys: PhoneKeys,
  phone: string,
  region: string,
): { phoneHash: string; region: string } {
  const parsed = normalizePhone(phone, region.toUpperCase() as 'IN');
  if (!parsed.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'phone is not a valid number', {
      context: { reason: parsed.reason },
    });
  return { phoneHash: hashPhone(parsed.phone.e164, keys.hashKey), region: parsed.phone.region };
}

export function registerConsentRoutes(app: FastifyInstance, deps: ConsentRouteDeps): void {
  app.post('/v1/consents', async (request, reply) => {
    const auth = requireScope(request, 'consents:write');
    const body = ConsentBody.parse(request.body);
    const { phoneHash, region } = toHash(deps.keys, body.phone, body.phone_region);
    const now = deps.clock();
    const capturedAt = body.captured_at === undefined ? now : new Date(body.captured_at);
    if (capturedAt.getTime() > now.getTime() + 60_000)
      throw new NaaradhError('VALIDATION_FAILED', 'captured_at is in the future');
    const r = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const c = await recordConsent(tx, {
        tenantId: auth.tenantId,
        phoneHash,
        purpose: body.purpose,
        source: body.source,
        recipientRegion: region,
        capturedAt,
        wordingVersion: body.wording_version,
        evidenceUri: body.evidence_uri,
        externalRef: body.external_ref,
      });
      await audit(tx, {
        tenantId: auth.tenantId,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'consent.recorded',
        targetType: 'consent',
        targetId: c.id,
        after: { purpose: body.purpose, source: body.source, region },
      });
      return c;
    });
    // E-08: an attestation is recorded but the caller is told it will not unlock promotional calls.
    return reply.code(201).send({
      consent_id: r.id,
      expires_at: r.expiresAt?.toISOString() ?? null,
      sufficient_for_promotional: body.source !== 'attestation',
    });
  });

  app.delete('/v1/consents', async (request, reply) => {
    const auth = requireScope(request, 'consents:write');
    const body = RevokeBody.parse(request.body);
    const { phoneHash, region } = toHash(deps.keys, body.phone, body.phone_region);
    const now = deps.clock();
    const revoked = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const n = await revokeConsent(tx, {
        tenantId: auth.tenantId,
        phoneHash,
        purpose: body.purpose,
        source: 'api',
        recipientRegion: region,
        at: now,
      });
      await audit(tx, {
        tenantId: auth.tenantId,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'consent.revoked',
        targetType: 'contact',
        targetId: phoneHash,
        after: { purpose: body.purpose, revoked: n },
      });
      return n;
    });
    return reply.code(200).send({ revoked });
  });

  app.post('/v1/suppressions', async (request, reply) => {
    const auth = requireScope(request, 'suppressions:write');
    const body = SuppressionBody.parse(request.body);
    const { phoneHash } = toHash(deps.keys, body.phone, body.phone_region);
    const now = deps.clock();
    const s = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const r = await suppress(tx, {
        scope: 'tenant',
        tenantId: auth.tenantId,
        phoneHash,
        purpose: body.purpose,
        reason: body.reason,
        at: now,
        externalRef: body.external_ref,
        notes: body.notes,
        createdBy: `api_key:${auth.apiKeyId}`,
      });
      if (r.created) {
        await audit(tx, {
          tenantId: auth.tenantId,
          actorType: 'api_key',
          actorId: auth.apiKeyId,
          action: 'suppression.created',
          targetType: 'suppression',
          targetId: r.id,
          after: { purpose: body.purpose, reason: body.reason },
        });
        await emitMerchantEvent(tx, auth.tenantId, {
          type: 'suppression.created',
          eventId: `${r.id}:created`,
          at: now,
          data: {
            suppression_id: r.id,
            reason: body.reason,
            purpose: body.purpose,
            until: r.until?.toISOString() ?? null,
          },
        });
      }
      return r;
    });
    return reply
      .code(s.created ? 201 : 200)
      .send({ suppression_id: s.id, created: s.created, until: s.until?.toISOString() ?? null });
  });
}
