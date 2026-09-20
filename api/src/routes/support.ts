import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, type Db } from '@naaradh/db';
import {
  AttestationInput,
  KnowledgeInput,
  ProfileInput,
  TransferTargetInput,
  audit,
  createArticle,
  createProfile,
  createTransferTarget,
  deactivateTransferTarget,
  eraseOrders,
  listArticles,
  listProfiles,
  listTickets,
  listTransferTargets,
  resolveTicket,
  setProfileStatus,
  updateArticle,
  updateProfile,
  upsertOrder,
  verifyTransferTarget,
  type Actor,
  type PhoneKeys,
} from '@naaradh/pipeline';
import { sanitiseMerchantText } from '@naaradh/call-scripts';
import { type PhoneRegion } from '@naaradh/shared';
import { requireScope, type AuthContext } from '../auth.js';

/**
 * The support line's configuration and data (ADR-0006, SPEC §9.1):
 *
 *   /v1/inbound-profiles   who answers, how, with which tools            support:write / support:read
 *   /v1/knowledge          what the agent may say about policies          support:write / support:read
 *   /v1/transfer-targets   the people a call may be handed to             support:write / support:read
 *   /v1/tickets            what the agent could not do                    tickets:read / tickets:write
 *   /v1/orders             the order cache, for non-Shopify merchants     orders:write
 *
 * The rules live in @naaradh/pipeline admin/support.ts, shared with the dashboards; these
 * routes are authentication, parsing and response shape. Staff numbers are encrypted with
 * the STAFF public key: the api can store them and never read them back.
 */
export interface SupportRouteDeps {
  readonly db: Db;
  readonly keys: PhoneKeys;
  readonly staffKey: { readonly publicKeyPem: string; readonly kid: number };
  readonly clock: () => Date;
}

const TrackingBody = z.object({
  company: z.string().max(80).nullable().default(null),
  number: z.string().max(80).nullable().default(null),
  url: z.string().url().max(500).nullable().default(null),
  status: z.string().max(40).nullable().default(null),
  estimated_delivery: z.string().max(40).nullable().default(null),
});

export const OrderBody = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().min(5).max(32).nullable().default(null),
  phone_region: z.string().length(2).default('IN'),
  pincode: z.string().max(12).nullable().default(null),
  payment: z.enum(['cod', 'prepaid', 'unknown']),
  financial_status: z.string().max(40).nullable().default(null),
  fulfillment_status: z.string().max(40).nullable().default(null),
  cancelled_at: z.string().datetime({ offset: true }).nullable().default(null),
  total_minor: z.number().int().min(0),
  currency: z.string().length(3),
  item_summary: z.string().max(200).default(''),
  item_count: z.number().int().min(0).default(0),
  placed_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).optional(),
  tracking: TrackingBody.nullable().optional(),
});

function actorOf(auth: AuthContext, request: FastifyRequest): Actor {
  return { tenantId: auth.tenantId, type: 'api_key', id: auth.apiKeyId, requestId: request.id };
}

export function registerSupportRoutes(app: FastifyInstance, deps: SupportRouteDeps): void {
  const staff = {
    hashKey: deps.keys.hashKey,
    publicKeyPem: deps.staffKey.publicKeyPem,
    kid: deps.staffKey.kid,
  };

  // ---- inbound profiles ---------------------------------------------------------------------------

  app.get('/v1/inbound-profiles', async (request) => {
    const auth = requireScope(request, 'support:read');
    return {
      data: await withTenant(deps.db, auth.tenantId, (tx) => listProfiles(tx, auth.tenantId)),
    };
  });

  app.post('/v1/inbound-profiles', async (request, reply) => {
    const auth = requireScope(request, 'support:write');
    const body = ProfileInput.parse(request.body);
    const r = await withTenant(deps.db, auth.tenantId, (tx) =>
      createProfile(tx, actorOf(auth, request), staff, body),
    );
    return reply.code(201).send(r);
  });

  /** Full replacement of the configuration; the version trigger stamps a new version. */
  app.put<{ Params: { id: string } }>('/v1/inbound-profiles/:id', async (request) => {
    const auth = requireScope(request, 'support:write');
    const body = ProfileInput.parse(request.body);
    return withTenant(deps.db, auth.tenantId, (tx) =>
      updateProfile(tx, actorOf(auth, request), staff, request.params.id, body),
    );
  });

  for (const [path, status] of [
    ['activate', 'active'],
    ['disable', 'disabled'],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/inbound-profiles/:id/${path}`, async (request) => {
      const auth = requireScope(request, 'support:write');
      return withTenant(deps.db, auth.tenantId, (tx) =>
        setProfileStatus(tx, actorOf(auth, request), request.params.id, status),
      );
    });
  }

  // ---- knowledge ---------------------------------------------------------------------------------------

  app.get('/v1/knowledge', async (request) => {
    const auth = requireScope(request, 'support:read');
    return {
      data: await withTenant(deps.db, auth.tenantId, (tx) => listArticles(tx, auth.tenantId)),
    };
  });

  app.post('/v1/knowledge', async (request, reply) => {
    const auth = requireScope(request, 'support:write');
    const body = KnowledgeInput.extend({
      status: z.enum(['draft', 'published']).default('draft'),
    }).parse(request.body);
    const r = await withTenant(deps.db, auth.tenantId, (tx) =>
      createArticle(tx, actorOf(auth, request), body),
    );
    return reply.code(201).send(r);
  });

  app.put<{ Params: { id: string } }>('/v1/knowledge/:id', async (request) => {
    const auth = requireScope(request, 'support:write');
    const body = KnowledgeInput.extend({
      status: z.enum(['draft', 'published', 'archived']),
    }).parse(request.body);
    return withTenant(deps.db, auth.tenantId, (tx) =>
      updateArticle(tx, actorOf(auth, request), request.params.id, body),
    );
  });

  // ---- transfer targets (invariant 19) --------------------------------------------------------------------

  app.get('/v1/transfer-targets', async (request) => {
    const auth = requireScope(request, 'support:read');
    return {
      data: await withTenant(deps.db, auth.tenantId, (tx) =>
        listTransferTargets(tx, auth.tenantId),
      ),
    };
  });

  app.post('/v1/transfer-targets', async (request, reply) => {
    const auth = requireScope(request, 'support:write');
    const body = TransferTargetInput.parse(request.body);
    const r = await withTenant(deps.db, auth.tenantId, (tx) =>
      createTransferTarget(tx, actorOf(auth, request), staff, body),
    );
    return reply.code(201).send(r);
  });

  app.post<{ Params: { id: string } }>('/v1/transfer-targets/:id/verify', async (request) => {
    const auth = requireScope(request, 'support:write');
    const body = AttestationInput.parse(request.body);
    return withTenant(deps.db, auth.tenantId, (tx) =>
      verifyTransferTarget(tx, actorOf(auth, request), request.params.id, body, deps.clock()),
    );
  });

  app.post<{ Params: { id: string } }>('/v1/transfer-targets/:id/deactivate', async (request) => {
    const auth = requireScope(request, 'support:write');
    return withTenant(deps.db, auth.tenantId, (tx) =>
      deactivateTransferTarget(tx, actorOf(auth, request), request.params.id),
    );
  });

  // ---- tickets --------------------------------------------------------------------------------------------------

  app.get<{ Querystring: { status?: string } }>('/v1/tickets', async (request) => {
    const auth = requireScope(request, 'tickets:read');
    const status = z
      .enum(['open', 'in_progress', 'resolved'])
      .optional()
      .parse(request.query.status);
    return {
      data: await withTenant(deps.db, auth.tenantId, (tx) =>
        listTickets(tx, auth.tenantId, { status }),
      ),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/tickets/:id/resolve', async (request) => {
    const auth = requireScope(request, 'tickets:write');
    const body = z.object({ resolution: z.string().trim().min(2).max(1000) }).parse(request.body);
    return withTenant(deps.db, auth.tenantId, (tx) =>
      resolveTicket(tx, actorOf(auth, request), request.params.id, body.resolution, deps.clock()),
    );
  });

  // ---- orders (the cache the agent answers from, for API merchants) ---------------------------------------

  app.put<{ Params: { externalId: string } }>('/v1/orders/:externalId', async (request) => {
    const auth = requireScope(request, 'orders:write');
    const body = OrderBody.parse(request.body);
    const externalId = z.string().min(1).max(200).parse(request.params.externalId);
    const now = deps.clock();
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const r = await upsertOrder(tx, deps.keys.hashKey, {
        tenantId: auth.tenantId,
        source: 'api',
        externalId,
        name: body.name,
        rawPhone: body.phone,
        defaultRegion: body.phone_region.toUpperCase() as PhoneRegion,
        pincode: body.pincode,
        paymentKind: body.payment,
        financialStatus: body.financial_status,
        fulfillmentStatus: body.fulfillment_status,
        cancelledAt: body.cancelled_at === null ? null : new Date(body.cancelled_at),
        totalMinor: body.total_minor,
        currency: body.currency.toUpperCase(),
        itemSummary: sanitiseMerchantText(body.item_summary, 200),
        itemCount: body.item_count,
        placedAt: new Date(body.placed_at),
        sourceUpdatedAt: body.updated_at === undefined ? now : new Date(body.updated_at),
        ...(body.tracking === undefined
          ? {}
          : {
              tracking:
                body.tracking === null
                  ? null
                  : {
                      company: body.tracking.company,
                      number: body.tracking.number,
                      url: body.tracking.url,
                      status: body.tracking.status,
                      estimatedDelivery: body.tracking.estimated_delivery,
                    },
            }),
      });
      return { id: r.id, applied: r.applied };
    });
  });

  app.delete<{ Params: { externalId: string } }>('/v1/orders/:externalId', async (request) => {
    const auth = requireScope(request, 'orders:write');
    const now = deps.clock();
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const n = await eraseOrders(
        tx,
        auth.tenantId,
        { externalIds: [request.params.externalId] },
        now,
      );
      await audit(tx, {
        tenantId: auth.tenantId,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'order.erased',
        targetType: 'order',
        targetId: request.params.externalId,
        after: { erased: n },
      });
      return { erased: n };
    });
  });
}
