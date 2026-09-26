import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@naaradh/db';
import {
  CRM_SIGNATURE_HEADER,
  crmSharedSecret,
  parseLead,
  verifyCrmSignature,
  verifyCrmTag,
  type CrmProvider,
  type FieldMap,
} from '@naaradh/crm';
import { sha256Hex } from '@naaradh/shared';
import { markFailed, markProcessed, markPublished, recordWebhook } from '../events.js';
import type { Publisher } from '../pubsub.js';

/**
 * POST /crm/:provider/:tenantTag — a new lead in Zoho or HubSpot (P5-CRM-1/2).
 *
 * Verify, dedupe, publish, 200 — like every other hook. The merchant points a workflow webhook
 * here; the intents worker turns the lead into a `lead_callback` intent through the same
 * `createIntent()` the public API uses, so the use case must be enabled on the account and the
 * gate still decides whether the call goes out and when.
 *
 * Authentication is the per-tenant URL (neither CRM signs a workflow webhook in a way we can
 * check per merchant), with an optional `x-naaradh-signature` on top for merchants whose CRM can
 * add headers. A present-but-wrong signature is always a 401.
 */
export interface CrmRouteDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  /** Null → every /crm route answers 404 (not configured in this environment). */
  readonly providerWebhookKey: string | null;
  readonly now?: () => Date;
}

export function registerCrmRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  app.post<{ Params: { provider: string; tenantTag: string } }>(
    '/crm/:provider/:tenantTag',
    async (request, reply) => {
      const key = deps.providerWebhookKey;
      if (key === null) return reply.code(404).send({ error: 'not found' });

      const verified = verifyCrmTag(key, request.params.provider, request.params.tenantTag);
      if (verified === null) {
        request.log.warn({ provider: request.params.provider }, 'crm webhook: bad url tag');
        return reply.code(404).send({ error: 'not found' });
      }
      const { provider, tenantId } = verified;
      const raw = request.body as Buffer;
      const now = deps.now?.() ?? new Date();
      const signature = header(request.headers[CRM_SIGNATURE_HEADER]);
      // Namespaced by tenant: webhook_events dedupes on (source, external_event_id) globally and
      // the key below is client-supplied, so without the prefix one merchant could claim an id
      // and silently swallow another's lead.
      const idempotencyKey = header(request.headers['x-idempotency-key']);
      const externalEventId = `${tenantId}:${idempotencyKey ?? `sha256:${sha256Hex(raw)}`}`;
      const headers = {
        'content-type': request.headers['content-type'],
        'x-idempotency-key': idempotencyKey,
      };

      const [integration] = await deps.db
        .select({ status: schema.integrations.status, metadata: schema.integrations.metadata })
        .from(schema.integrations)
        .where(
          and(
            eq(schema.integrations.tenantId, tenantId),
            eq(schema.integrations.kind, provider),
            eq(schema.integrations.status, 'active'),
          ),
        )
        .limit(1);

      const settings = (integration?.metadata as { crm?: { signature?: unknown } } | null)?.crm;
      const verdict = verifyCrmSignature({
        secret: crmSharedSecret(key, provider, tenantId),
        raw,
        signature,
        required: settings?.signature === 'required',
      });
      if (!verdict.ok) {
        await recordWebhook(deps.db, {
          source: provider,
          externalEventId: `rejected:${externalEventId}`,
          topic: 'crm/lead',
          tenantId,
          externalAccount: null,
          signatureValid: false,
          payload: null,
          payloadSha256: sha256Hex(raw),
          headers,
        });
        request.log.warn(
          { provider, tenant_id: tenantId, reason: verdict.reason },
          'crm webhook rejected',
        );
        return reply.code(401).send({ error: 'invalid signature', reason: verdict.reason });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'body is not JSON' });
      }

      const recorded = await recordWebhook(deps.db, {
        source: provider,
        externalEventId,
        topic: 'crm/lead',
        tenantId,
        externalAccount: null,
        signatureValid: true,
        payload,
        payloadSha256: sha256Hex(raw),
        headers,
      });
      if (recorded.kind === 'duplicate')
        return reply.code(200).send({ status: 'duplicate', id: recorded.id });

      if (integration === undefined) {
        await markProcessed(deps.db, recorded.id, 'integration_not_active');
        return reply
          .code(200)
          .send({ status: 'ignored', reason: 'integration_not_active', id: recorded.id });
      }

      // Read here only to refuse a body no worker could use. The error names the field, because
      // "which field is your phone in?" is the whole of CRM onboarding.
      const parsed = parseLead(provider, payload, fieldsOf(integration.metadata), now);
      if (!parsed.ok) {
        await markProcessed(deps.db, recorded.id, `bad_payload:${parsed.error.slice(0, 180)}`);
        request.log.warn({ provider, tenant_id: tenantId }, 'crm webhook: unreadable lead');
        return reply.code(202).send({
          status: 'ignored',
          reason: 'bad_payload',
          detail: parsed.error,
          id: recorded.id,
        });
      }

      try {
        const messageId = await deps.publisher.publish('provider.events', {
          webhook_event_id: recorded.id,
          source: provider,
          topic: 'crm/lead',
          tenant_id: tenantId,
          external_account: null,
          received_at: now.toISOString(),
        });
        await markPublished(deps.db, recorded.id, messageId);
        return await reply.code(200).send({
          status: recorded.kind === 'retry' ? 'republished' : 'published',
          id: recorded.id,
        });
      } catch (error) {
        await markFailed(
          deps.db,
          recorded.id,
          error instanceof Error ? error.message : String(error),
        );
        request.log.error({ err: error, id: recorded.id }, 'crm publish failed');
        return reply.code(500).send({ status: 'publish_failed', id: recorded.id });
      }
    },
  );
}

/** `integrations.metadata.crm.fields` — the merchant's own field names, if they set any. */
function fieldsOf(metadata: unknown): FieldMap | undefined {
  const fields = (metadata as { crm?: { fields?: unknown } } | null)?.crm?.fields;
  if (fields === null || typeof fields !== 'object') return undefined;
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value;
    else if (typeof value === 'string') out[key] = [value];
  }
  return out as FieldMap;
}

/** Kept in step with the OCC route: only the first value of a repeated header is read. */
function header(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export type { CrmProvider };
