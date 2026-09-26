import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@naaradh/db';
import {
  SIGNATURE_HEADERS,
  effectiveSignaturePolicy,
  occSharedSecret,
  parseOccCheckout,
  verifyOccSignature,
  verifyOccTag,
  type OccProvider,
  type SignaturePolicy,
} from '@naaradh/occ';
import { sha256Hex } from '@naaradh/shared';
import { markFailed, markProcessed, markPublished, recordWebhook } from '../events.js';
import type { Publisher } from '../pubsub.js';

/**
 * POST /occ/:provider/:tenantTag — abandoned carts from a one-click checkout (E-14, P5-OCC-2).
 *
 * A merchant on GoKwik, Shiprocket, Razorpay Magic or Cashfree OCC gets no Shopify
 * `checkouts/*` webhooks at all, because the checkout is not Shopify's. The provider posts here
 * instead, and from `provider.events` on the cart takes exactly the same path as a Shopify one:
 * `recordCheckout` keeps the newest state, the sweep turns an idle **consented** cart into one
 * abandoned-cart intent, and the gate decides the rest.
 *
 * The four steps are the same as every other hook — verify, dedupe, publish, 200 — with one
 * difference worth stating plainly: two of these providers publish no signing scheme, so the
 * URL itself is the credential. It is minted from `PROVIDER_WEBHOOK_KEY`, it names exactly one
 * tenant, and it is checked before a byte of the body is parsed (invariant 9). A body that
 * arrives on the wrong URL cannot reach another merchant's data, and a body that arrives with a
 * signature we can check must pass it.
 *
 * What a forged body still cannot do, even with the URL: cause a call. `abandoned_cart` is
 * promotional, so the gate requires a consent row for that number (invariant 5), the cart is
 * called once at most, and suppressions and the calling window apply as always.
 */
export interface OccRouteDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  /** Null → every /occ route answers 404 (the feature is not configured in this environment). */
  readonly providerWebhookKey: string | null;
  readonly now?: () => Date;
}

interface IntegrationRow {
  readonly id: string;
  readonly status: string;
  readonly metadata: unknown;
}

export function registerOccRoutes(app: FastifyInstance, deps: OccRouteDeps): void {
  app.post<{ Params: { provider: string; tenantTag: string } }>(
    '/occ/:provider/:tenantTag',
    async (request, reply) => {
      const key = deps.providerWebhookKey;
      if (key === null) return reply.code(404).send({ error: 'not found' });

      // 1. The URL. An unknown provider or a tag that does not verify is indistinguishable from
      //    a scan: 404, nothing recorded, no hint about which half was wrong.
      const verified = verifyOccTag(key, request.params.provider, request.params.tenantTag);
      if (verified === null) {
        request.log.warn({ provider: request.params.provider }, 'occ webhook: bad url tag');
        return reply.code(404).send({ error: 'not found' });
      }
      const { provider, tenantId } = verified;
      const raw = request.body as Buffer;
      const now = deps.now?.() ?? new Date();
      const headerNames = SIGNATURE_HEADERS[provider];
      const signature = header(request.headers[headerNames.signature]);
      const timestamp =
        headerNames.timestamp === undefined
          ? undefined
          : header(request.headers[headerNames.timestamp]);
      const idempotencyKey = header(request.headers['x-idempotency-key']);
      // Namespaced by tenant. `webhook_events` deduplicates on (source, external_event_id), and
      // `source` here is the provider — shared by every merchant on it. The key itself comes
      // from a request header no provider signs, so without the tenant prefix one merchant
      // could burn an id and silently swallow another merchant's genuine cart.
      const eventKey = idempotencyKey ?? `sha256:${sha256Hex(raw)}`;
      const externalEventId = `${tenantId}:${eventKey}`;
      const headers = {
        'content-type': request.headers['content-type'],
        'x-idempotency-key': idempotencyKey,
        ...(headerNames.timestamp === undefined ? {} : { [headerNames.timestamp]: timestamp }),
      };

      // 2. The integration. The tenant comes from the verified URL, never from the body: these
      //    payloads carry a `shop_id` or `store_url` that nothing proves.
      const [integration] = await deps.db
        .select({
          id: schema.integrations.id,
          status: schema.integrations.status,
          metadata: schema.integrations.metadata,
        })
        .from(schema.integrations)
        .where(
          and(
            eq(schema.integrations.tenantId, tenantId),
            eq(schema.integrations.kind, provider),
            eq(schema.integrations.status, 'active'),
          ),
        )
        .limit(1);

      // 3. The provider's own signature, under this integration's policy.
      const policy = policyOf(integration, provider);
      const verdict = verifyOccSignature({
        provider,
        secret: occSharedSecret(key, provider, tenantId),
        raw,
        signature,
        timestamp,
        policy,
        now,
      });
      if (!verdict.ok) {
        await recordWebhook(deps.db, {
          source: provider,
          externalEventId: `rejected:${externalEventId}`,
          topic: 'occ/checkout',
          tenantId,
          externalAccount: null,
          signatureValid: false,
          payload: null,
          payloadSha256: sha256Hex(raw),
          headers,
        });
        request.log.warn(
          { provider, tenant_id: tenantId, reason: verdict.reason },
          'occ webhook rejected',
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
        topic: 'occ/checkout',
        tenantId,
        externalAccount: null,
        signatureValid: true,
        payload,
        payloadSha256: sha256Hex(raw),
        headers,
      });
      if (recorded.kind === 'duplicate')
        return reply.code(200).send({ status: 'duplicate', id: recorded.id });

      // An integration that was never enabled, or was revoked: the URL stays valid (the provider
      // will keep posting until the merchant turns it off there) but nothing is acted on.
      if (integration === undefined) {
        await markProcessed(deps.db, recorded.id, 'integration_not_active');
        return reply
          .code(200)
          .send({ status: 'ignored', reason: 'integration_not_active', id: recorded.id });
      }

      // 4. Parsed here only to reject a body no worker could read; the worker re-reads the stored
      //    payload under the tenant's RLS and does the writing.
      const parsed = parseOccCheckout(provider, payload, now);
      if (!parsed.ok) {
        await markProcessed(deps.db, recorded.id, `bad_payload:${parsed.error.slice(0, 180)}`);
        request.log.warn({ provider, tenant_id: tenantId }, 'occ webhook: unreadable cart');
        return reply.code(202).send({ status: 'ignored', reason: 'bad_payload', id: recorded.id });
      }

      try {
        const messageId = await deps.publisher.publish('provider.events', {
          webhook_event_id: recorded.id,
          source: provider,
          topic: 'occ/checkout',
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
        request.log.error({ err: error, id: recorded.id }, 'occ publish failed');
        // 500 → the provider retries → recordWebhook returns 'retry' → we publish again.
        return reply.code(500).send({ status: 'publish_failed', id: recorded.id });
      }
    },
  );
}

/**
 * `integrations.metadata.occ.signature`, but only ever as a tightening. A provider that publishes
 * a signing scheme is verified against it whatever the row says, so neither a typo in the
 * dashboard nor a writable metadata field can switch verification off (invariant 9).
 */
function policyOf(integration: IntegrationRow | undefined, provider: OccProvider): SignaturePolicy {
  const configured = (integration?.metadata as { occ?: { signature?: unknown } } | null | undefined)
    ?.occ?.signature;
  return effectiveSignaturePolicy(provider, configured);
}

function header(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}
