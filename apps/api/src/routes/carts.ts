import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withTenant, type Db } from '@naaradh/db';
import {
  CURRENT_CONSENT_WORDING,
  convertCheckouts,
  recordCheckout,
  type PhoneKeys,
} from '@naaradh/pipeline';
import { NaaradhError, type PhoneRegion } from '@naaradh/shared';
import { requireScope } from '../auth.js';

/**
 * PUT /v1/carts/{ref}, POST /v1/carts/{ref}/completed, GET /v1/carts/{ref} — abandoned-cart
 * ingestion for every platform that is not Shopify (ADR-0011 §1): the WooCommerce plugin, a
 * one-click-checkout provider's glue, or a bespoke store.
 *
 * This is the same `recordCheckout()` the Shopify webhook path uses, so the rules cannot drift:
 * a cart is called only when it has been idle 45 minutes, is under 24 hours old, has a phone,
 * and carries a live consent from the wording Naaradh published (ADR-0010). Sending a cart is
 * not an instruction to call it.
 */

export const CartBody = z.object({
  /** Any format the merchant has; normalised here, never stored as sent. */
  phone: z.string().min(5).max(32).nullable().default(null),
  phone_region: z.string().length(2).default('IN'),
  /** The shopper's first name, for the greeting. No surname, no email, no address. */
  name: z.string().trim().max(80).nullable().default(null),
  value_minor: z.number().int().min(0).default(0),
  currency: z.string().length(3).default('INR'),
  /** What is in the cart, as the agent should say it ("2 items", "1 × Cotton kurta"). */
  item_summary: z.string().trim().max(200).default(''),
  item_count: z.number().int().min(0).max(999).default(0),
  /**
   * The version of Naaradh's consent wording the shopper ticked, or null when they did not.
   * Anything else is not consent (E-106) and the cart is recorded but never called.
   */
  consent_wording_version: z.string().trim().max(64).nullable().default(null),
  /** When the cart was started and last touched. The 24-hour deadline runs from `created_at`. */
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).optional(),
  /** Tags Naaradh must not call (`staff`, `naaradh:skip`). */
  customer_tags: z.array(z.string().max(40)).max(20).default([]),
});

export const CompletedBody = z.object({
  /** The order the cart became, when there is one — links the cart to the order cache. */
  order_ref: z.string().trim().min(1).max(200).nullable().default(null),
  completed_at: z.string().datetime({ offset: true }).optional(),
});

export interface CartRouteDeps {
  readonly db: Db;
  readonly keys: PhoneKeys;
  readonly clock: () => Date;
}

const Ref = z.string().trim().min(1).max(200);

export function registerCartRoutes(app: FastifyInstance, deps: CartRouteDeps): void {
  app.put<{ Params: { ref: string } }>('/v1/carts/:ref', async (request, reply) => {
    const auth = requireScope(request, 'carts:write');
    const ref = Ref.parse(request.params.ref);
    const body = CartBody.parse(request.body);
    const now = deps.clock();
    const createdAt = new Date(body.created_at);
    if (createdAt.getTime() > now.getTime() + 60_000)
      throw new NaaradhError('VALIDATION_FAILED', 'created_at is in the future');

    const result = await withTenant(deps.db, auth.tenantId, (tx) =>
      recordCheckout(tx, deps.keys, {
        tenantId: auth.tenantId,
        source: 'api',
        externalId: ref,
        createdAt,
        updatedAt: body.updated_at === undefined ? now : new Date(body.updated_at),
        completedAt: null,
        rawPhone: body.phone,
        defaultRegion: body.phone_region.toUpperCase() as PhoneRegion,
        firstName: body.name,
        valueMinor: body.value_minor,
        currency: body.currency.toUpperCase(),
        itemSummary: body.item_summary,
        itemCount: body.item_count,
        consentAttribute: body.consent_wording_version,
        customerTags: body.customer_tags,
        isDraftOrPos: false,
        now,
      }),
    );

    if (result.kind === 'ignored')
      return reply.code(200).send({ status: 'ignored', reason: result.reason });
    return reply.code(200).send({
      cart_ref: ref,
      status: result.status,
      consent: result.consent,
      /** What the merchant should show a shopper who asks: the wording we recognise today. */
      current_consent_wording_version: CURRENT_CONSENT_WORDING,
    });
  });

  app.post<{ Params: { ref: string } }>('/v1/carts/:ref/completed', async (request, reply) => {
    const auth = requireScope(request, 'carts:write');
    const ref = Ref.parse(request.params.ref);
    const body = CompletedBody.parse(request.body ?? {});
    const now = deps.clock();
    const completedAt = body.completed_at === undefined ? now : new Date(body.completed_at);

    const result = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const [cart] = await tx
        .select({ id: schema.checkouts.id, phoneHash: schema.checkouts.phoneHash })
        .from(schema.checkouts)
        .where(
          and(
            eq(schema.checkouts.tenantId, auth.tenantId),
            eq(schema.checkouts.source, 'api'),
            eq(schema.checkouts.externalId, ref),
          ),
        )
        .limit(1);
      if (cart === undefined) throw new NaaradhError('NOT_FOUND', 'cart not found');

      // The order row, when the merchant has already sent it (PUT /v1/orders/{ref}).
      const [order] =
        body.order_ref === null
          ? []
          : await tx
              .select({ id: schema.orders.id })
              .from(schema.orders)
              .where(
                and(
                  eq(schema.orders.tenantId, auth.tenantId),
                  eq(schema.orders.source, 'api'),
                  eq(schema.orders.externalId, body.order_ref),
                ),
              )
              .limit(1);

      // E-123: the cart is closed and any queued recovery call for it is cancelled.
      return convertCheckouts(tx, {
        tenantId: auth.tenantId,
        orderId: order?.id ?? null,
        phoneHash: cart.phoneHash,
        checkoutToken: ref,
        placedAt: completedAt,
        now,
      });
    });
    return reply.code(200).send({
      cart_ref: ref,
      status: 'completed',
      cancelled_calls: result.cancelledIntents,
    });
  });

  app.get<{ Params: { ref: string } }>('/v1/carts/:ref', async (request) => {
    const auth = requireScope(request, 'carts:write');
    const ref = Ref.parse(request.params.ref);
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const [cart] = await tx
        .select({
          status: schema.checkouts.status,
          skipReason: schema.checkouts.skipReason,
          intentId: schema.checkouts.intentId,
          consentWording: schema.checkouts.consentWording,
          createdAt: schema.checkouts.sourceCreatedAt,
          updatedAt: schema.checkouts.sourceUpdatedAt,
          sweptAt: schema.checkouts.sweptAt,
        })
        .from(schema.checkouts)
        .where(
          and(
            eq(schema.checkouts.tenantId, auth.tenantId),
            eq(schema.checkouts.source, 'api'),
            eq(schema.checkouts.externalId, ref),
          ),
        )
        .limit(1);
      if (cart === undefined) throw new NaaradhError('NOT_FOUND', 'cart not found');
      return {
        cart_ref: ref,
        status: cart.status,
        reason: cart.skipReason,
        intent_id: cart.intentId,
        consent_wording_version: cart.consentWording,
        created_at: cart.createdAt.toISOString(),
        updated_at: cart.updatedAt.toISOString(),
        decided_at: cart.sweptAt?.toISOString() ?? null,
      };
    });
  });
}
