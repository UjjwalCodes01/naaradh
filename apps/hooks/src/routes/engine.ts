import type { FastifyInstance } from 'fastify';
import type { Db } from '@naaradh/db';
import { SignatureInvalidError, sha256Hex, verifyEngineWebhookTag } from '@naaradh/shared';
import { withoutRefusedMedia } from '@naaradh/engines-core';
import { isVendor, type EngineRegistry } from '@naaradh/engines-registry';
import { markFailed, markPublished, recordWebhook } from '../events.js';
import type { Publisher } from '../pubsub.js';

/**
 * POST /engine/:vendor/:tenantTag — vendor call events. The adapter verifies the vendor's
 * signature (invariant 9); the tag binds the URL to a tenant. Unsigned vendors get their
 * event recorded with signature_valid=false and the results-consumer re-fetches before
 * trusting it (E-23) — that policy lives there, not here.
 */
export interface EngineRouteDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly registry: EngineRegistry;
  readonly webhookKey: string;
}

export function registerEngineRoutes(app: FastifyInstance, deps: EngineRouteDeps): void {
  app.post<{ Params: { vendor: string; tenantTag: string } }>(
    '/engine/:vendor/:tenantTag',
    async (request, reply) => {
      const { vendor, tenantTag } = request.params;
      if (!isVendor(vendor)) return reply.code(404).send({ error: 'not found' });
      const tenantId = verifyEngineWebhookTag(deps.webhookKey, vendor, tenantTag);
      // A bad tag is indistinguishable from a bad URL on purpose: no oracle for guessing tags.
      if (tenantId === null) return reply.code(404).send({ error: 'not found' });

      const raw = request.body as Buffer;
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
      );
      const source = `engine_${vendor}` as const;
      const adapter = deps.registry.get(vendor);

      let event;
      try {
        event = adapter.parseWebhook(headers, raw);
      } catch (error) {
        if (error instanceof SignatureInvalidError) {
          await recordWebhook(deps.db, {
            source,
            externalEventId: `rejected:${sha256Hex(raw)}`,
            topic: 'unknown',
            tenantId,
            externalAccount: vendor,
            signatureValid: false,
            payload: null,
            payloadSha256: sha256Hex(raw),
            headers,
          });
          request.log.warn(
            { vendor, tenant_id: tenantId },
            'engine webhook rejected: bad signature',
          );
          return reply.code(401).send({ error: 'invalid signature' });
        }
        request.log.warn({ err: error, vendor }, 'engine webhook unparseable');
        return reply.code(400).send({ error: 'unparseable' });
      }

      // The NORMALISED event is what gets stored: the results-consumer never sees vendor
      // wire formats, and the adapter's signature check has already happened here.
      const recorded = await recordWebhook(deps.db, {
        source,
        externalEventId: event.eventId,
        topic: event.type,
        tenantId,
        externalAccount: vendor,
        signatureValid: adapter.capabilities().signedWebhooks,
        // A refused recording is stripped here, before storage — not later in the worker.
        payload: withoutRefusedMedia(event),
        payloadSha256: sha256Hex(raw),
        headers,
      });
      if (recorded.kind === 'duplicate')
        return reply.code(200).send({ status: 'duplicate', id: recorded.id });

      try {
        const messageId = await deps.publisher.publish('engine.events', {
          webhook_event_id: recorded.id,
          source,
          topic: event.type,
          tenant_id: tenantId,
          external_account: vendor,
          received_at: new Date().toISOString(),
        });
        await markPublished(deps.db, recorded.id, messageId);
        return await reply.code(200).send({ status: 'published', id: recorded.id });
      } catch (error) {
        await markFailed(
          deps.db,
          recorded.id,
          error instanceof Error ? error.message : String(error),
        );
        return reply.code(500).send({ status: 'publish_failed', id: recorded.id });
      }
    },
  );
}
