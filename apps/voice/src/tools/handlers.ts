import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import {
  CALLER_ID_ORDER_LOOKBACK_DAYS,
  CANCEL_TOKEN_TTL_SEC,
  KNOWLEDGE_MAX_RESULTS,
  KNOWLEDGE_SNIPPET_MAX_CHARS,
  LOOKUP_MAX_ORDERS,
  VERIFY_MAX_FAILURES,
  canDiscussOrder,
  cancellationPolicy,
  isShipped,
  suppress,
  transferPolicy,
  type OrderFacts,
} from '@naaradh/compliance';
import {
  audit,
  cancelIntents,
  createTicket,
  emitMerchantEvent,
  findConfirmation,
  hashConfirmToken,
  newConfirmToken,
  orderByRef,
  ordersByIds,
  ordersForCaller,
  searchKnowledge,
  toOrderView,
  verifyCaller,
  type OrderRow,
} from '@naaradh/pipeline';
import { sanitiseMerchantText, type ToolArgsOf, type ToolName } from '@naaradh/scripts';
import { addDays, decryptPhone, newId } from '@naaradh/shared';
import { hoursText, loadTransferTarget, profileHours, targetHours } from '../profiles.js';
import { callerState, fail, ok, type HandlerOutcome, type ToolCtx } from './types.js';

/**
 * One function per tool (AGENTS §5.9). Each reads identity from the attempt row, decides with
 * the pure policies in packages/compliance, and returns ONLY what the agent may say. Nothing
 * here trusts an argument to mean more than its schema says (E-90).
 */

type Handler<T extends ToolName> = (ctx: ToolCtx, args: ToolArgsOf<T>) => Promise<HandlerOutcome>;

const MAX_TICKETS_PER_CALL = 3;

function facts(o: OrderRow): OrderFacts {
  return {
    id: o.id,
    phoneHash: o.phoneHash,
    paymentKind: o.paymentKind,
    fulfillmentStatus: o.fulfillmentStatus,
    cancelledAt: o.cancelledAt,
  };
}

/** Same answer whether the order does not exist or is someone else's — no oracle (E-82). */
function needVerification(ctx: ToolCtx): HandlerOutcome {
  if (ctx.attempt.verifyFailures >= VERIFY_MAX_FAILURES) {
    return {
      status: 'refused',
      result: fail(
        { need_verification: true, verification_locked: true },
        "I'm sorry, I can't verify the order on this call. I can ask the team to call you back.",
      ),
    };
  }
  const canVerify = ctx.tools.includes('verify_caller');
  return {
    status: 'needs_verification',
    result: fail(
      { need_verification: true, can_verify: canVerify },
      canVerify
        ? 'To help with that order, please tell me the order number and the delivery pincode.'
        : 'I can’t see that order from this number. I can ask the team to call you back.',
    ),
  };
}

async function discussableOrder(ctx: ToolCtx, ref: string): Promise<OrderRow | null> {
  const order = await orderByRef(ctx.tx, ctx.tenantId, ref);
  if (order === null) return null;
  return canDiscussOrder(callerState(ctx.attempt), facts(order)) ? order : null;
}

/** E-97: the caller settled the order on THIS call, so the queued COD confirmation call is redundant. */
async function cancelRedundantCodCall(
  ctx: ToolCtx,
  order: OrderRow,
  reason: string,
): Promise<string[]> {
  if (ctx.attempt.direction !== 'inbound') return [];
  const r = await cancelIntents(ctx.tx, {
    tenantId: ctx.tenantId,
    externalRef: order.externalId,
    useCase: 'cod_confirm',
    queuedOnly: true,
    reason,
    at: ctx.now,
    actor: { type: 'agent', id: ctx.attempt.id },
  });
  return r.cancelled;
}

// ---------------------------------------------------------------------------------------------

const lookupOrders: Handler<'lookup_orders'> = async (ctx, args) => {
  if (args.order_ref !== undefined) {
    const order = await discussableOrder(ctx, args.order_ref);
    if (order === null) return needVerification(ctx);
    return {
      status: 'ok',
      orderId: order.id,
      result: ok({ found: true, orders: [toOrderView(order)] }),
    };
  }
  const caller = callerState(ctx.attempt);
  const since = addDays(ctx.now, -CALLER_ID_ORDER_LOOKBACK_DAYS);
  const mine =
    caller.callerHash === null
      ? []
      : await ordersForCaller(ctx.tx, ctx.tenantId, caller.callerHash, since, LOOKUP_MAX_ORDERS);
  const proven = await ordersByIds(ctx.tx, ctx.tenantId, ctx.attempt.verifiedOrderIds);
  const byId = new Map<string, OrderRow>();
  for (const o of [...mine, ...proven]) byId.set(o.id, o);
  const orders = [...byId.values()]
    .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())
    .slice(0, LOOKUP_MAX_ORDERS);
  if (orders.length === 0) return needVerification(ctx);
  return {
    status: 'ok',
    orderId: orders.length === 1 ? (orders[0]?.id ?? null) : null,
    result: ok({ found: true, orders: orders.map(toOrderView) }),
  };
};

const verifyCallerTool: Handler<'verify_caller'> = async (ctx, args) => {
  const r = await verifyCaller(
    ctx.tx,
    ctx.deps.keys.hashKey,
    ctx.tenantId,
    {
      attemptId: ctx.attempt.id,
      direction: ctx.attempt.direction,
      callerHash: ctx.attempt.phoneHash,
      identity: ctx.attempt.callerVerification,
      verifiedOrderIds: ctx.attempt.verifiedOrderIds,
      verifyFailures: ctx.attempt.verifyFailures,
    },
    args.order_ref,
    args.pincode,
    ctx.now,
  );
  if (r.ok) {
    const [order] = await ordersByIds(ctx.tx, ctx.tenantId, [r.orderId]);
    return {
      status: 'ok',
      orderId: r.orderId,
      result: ok(
        { verified: true, orders: order === undefined ? [] : [toOrderView(order)] },
        'Thank you, that matches.',
      ),
    };
  }
  if (r.locked) {
    return {
      status: 'refused',
      result: fail(
        { verified: false, verification_locked: true },
        "I'm sorry, I couldn't verify those details. I can ask the team to call you back.",
      ),
    };
  }
  // Never which factor was wrong (E-94).
  return {
    status: 'refused',
    result: fail(
      { verified: false, attempts_left: VERIFY_MAX_FAILURES - r.failures },
      "Those details don't match. Could you check the order number and pincode once more?",
    ),
  };
};

const searchKnowledgeTool: Handler<'search_knowledge'> = async (ctx, args) => {
  const hits = await searchKnowledge(
    ctx.tx,
    ctx.tenantId,
    args.query,
    KNOWLEDGE_MAX_RESULTS,
    KNOWLEDGE_SNIPPET_MAX_CHARS,
  );
  if (hits.length === 0) {
    // E-91: no article, no answer.
    return {
      status: 'ok',
      result: ok(
        { found: false, can_create_ticket: ctx.tools.includes('create_ticket') },
        "I don't have that information right now. I can ask the team to get back to you.",
      ),
    };
  }
  return { status: 'ok', result: ok({ found: true, articles: hits }) };
};

const confirmOrder: Handler<'confirm_order'> = async (ctx, args) => {
  const order = await discussableOrder(ctx, args.order_ref);
  if (order === null) return needVerification(ctx);
  if (order.cancelledAt !== null) {
    return {
      status: 'refused',
      orderId: order.id,
      result: fail(
        { confirmed: false, reason: 'already_cancelled' },
        'That order has already been cancelled.',
      ),
    };
  }
  if (order.paymentKind !== 'cod') {
    return {
      status: 'ok',
      orderId: order.id,
      result: ok(
        { confirmed: true, confirmation_needed: false },
        'That order does not need a confirmation — it is being processed.',
      ),
    };
  }
  const cancelled = await cancelRedundantCodCall(ctx, order, 'confirmed_on_inbound');
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    actorType: 'agent',
    actorId: ctx.attempt.id,
    action: 'order.confirmed_by_caller',
    targetType: 'order',
    targetId: order.id,
    after: { attempt_id: ctx.attempt.id, cancelled_intents: cancelled },
  });
  await emitMerchantEvent(ctx.tx, ctx.tenantId, {
    type: 'order.confirmed_by_caller',
    eventId: `${ctx.attempt.id}:${order.id}:confirmed`,
    at: ctx.now,
    data: {
      order_id: order.id,
      external_id: order.externalId,
      order_name: order.name,
      attempt_id: ctx.attempt.id,
      cancelled_intents: cancelled,
    },
  });
  return {
    status: 'approved',
    orderId: order.id,
    result: ok({ confirmed: true }, `Thank you — order ${order.name} is confirmed.`),
  };
};

const requestCancellation: Handler<'request_cancellation'> = async (ctx, args) => {
  const order = await discussableOrder(ctx, args.order_ref);
  if (order === null) return needVerification(ctx);
  const agentCancelEnabled = ctx.profile?.agentCancelEnabled ?? false;
  const view = toOrderView(order);

  // ---- step 1: readback + single-use token (E-84) -------------------------------------------
  if (args.confirm_token === undefined) {
    const decision = cancellationPolicy(callerState(ctx.attempt), facts(order), agentCancelEnabled);
    if (decision.kind === 'refuse') {
      return decision.reason === 'already_cancelled'
        ? {
            status: 'refused',
            orderId: order.id,
            result: fail(
              { cancelled: false, reason: 'already_cancelled' },
              'That order is already cancelled.',
            ),
          }
        : needVerification(ctx);
    }
    const { token, hash } = newConfirmToken();
    const readback = {
      order_ref: view.order_ref,
      items: view.items,
      total: view.total,
      placed_on: view.placed_on,
      payment: view.payment,
    };
    const willDo = decision.kind === 'execute' ? 'cancel' : 'request_to_team';
    return {
      status: 'awaiting_confirmation',
      orderId: order.id,
      confirmTokenHash: hash,
      tokenExpiresAt: new Date(ctx.now.getTime() + CANCEL_TOKEN_TTL_SEC * 1000),
      result: ok(
        { needs_confirmation: true, readback, if_confirmed: willDo, confirm_token: token },
        `Just to confirm: you want to cancel order ${view.order_ref} — ${view.items}, ${view.total}. Shall I go ahead?`,
      ),
      stored: { needs_confirmation: true, readback, if_confirmed: willDo },
    };
  }

  // ---- step 2: the caller said yes ---------------------------------------------------------------
  const step1 = await findConfirmation(
    ctx.tx,
    ctx.attempt.id,
    hashConfirmToken(args.confirm_token),
  );
  if (
    step1 === null ||
    step1.tool !== 'request_cancellation' ||
    step1.status !== 'awaiting_confirmation'
  ) {
    return {
      status: 'refused',
      orderId: order.id,
      result: fail(
        { cancelled: false, reason: 'invalid_token' },
        'Let me read the order back to you first.',
      ),
    };
  }
  if (step1.orderId !== order.id) {
    return {
      status: 'refused',
      orderId: order.id,
      result: fail(
        { cancelled: false, reason: 'token_mismatch' },
        'Let me read that order back to you first.',
      ),
    };
  }
  if (step1.tokenExpiresAt === null || step1.tokenExpiresAt.getTime() < ctx.now.getTime()) {
    return {
      status: 'refused',
      orderId: order.id,
      result: fail(
        { cancelled: false, reason: 'token_expired' },
        'Let me read the order back to you once more.',
      ),
    };
  }
  const [spent] = await ctx.tx
    .select({ id: schema.agentActions.id })
    .from(schema.agentActions)
    .where(eq(schema.agentActions.parentActionId, step1.id))
    .limit(1);
  if (spent !== undefined) {
    return {
      status: 'refused',
      orderId: order.id,
      result: fail(
        { cancelled: false, reason: 'token_used' },
        'That cancellation has already been submitted.',
      ),
    };
  }

  // Re-evaluated: the order may have shipped in the minute between the two steps (E-85).
  const decision = cancellationPolicy(callerState(ctx.attempt), facts(order), agentCancelEnabled);
  if (decision.kind === 'refuse') {
    return decision.reason === 'already_cancelled'
      ? {
          status: 'refused',
          orderId: order.id,
          result: fail(
            { cancelled: false, reason: 'already_cancelled' },
            'That order is already cancelled.',
          ),
        }
      : needVerification(ctx);
  }

  const reason = args.reason === undefined ? null : sanitiseMerchantText(args.reason, 200);
  if (decision.kind === 'execute') {
    const [live] = await ctx.tx
      .select({ id: schema.orderActions.id })
      .from(schema.orderActions)
      .where(
        and(
          eq(schema.orderActions.orderId, order.id),
          eq(schema.orderActions.kind, 'cancel'),
          inArray(schema.orderActions.status, ['pending', 'executing', 'done']),
        ),
      )
      .limit(1);
    if (live !== undefined) {
      return {
        status: 'approved',
        orderId: order.id,
        parentActionId: step1.id,
        result: ok(
          { cancellation: 'already_submitted' },
          `The cancellation for order ${view.order_ref} is already being processed.`,
        ),
      };
    }
    const cancelled = await cancelRedundantCodCall(ctx, order, 'cancelled_on_inbound');
    return {
      status: 'approved',
      orderId: order.id,
      parentActionId: step1.id,
      result: ok(
        { cancellation: 'submitted' },
        `I've placed the cancellation for order ${view.order_ref}. The store will send you a confirmation shortly.`,
      ),
      after: async () => {
        await ctx.tx.insert(schema.orderActions).values({
          id: newId('orderAction'),
          tenantId: ctx.tenantId,
          agentActionId: ctx.actionId,
          orderId: order.id,
          kind: 'cancel',
          status: 'pending',
          nextAttemptAt: ctx.now,
        });
        await audit(ctx.tx, {
          tenantId: ctx.tenantId,
          actorType: 'agent',
          actorId: ctx.attempt.id,
          action: 'order.cancel_approved',
          targetType: 'order',
          targetId: order.id,
          after: {
            agent_action_id: ctx.actionId,
            confirmation_action_id: step1.id,
            cancelled_intents: cancelled,
          },
        });
        await emitMerchantEvent(ctx.tx, ctx.tenantId, {
          type: 'order.cancellation_requested',
          eventId: `${ctx.actionId}:cancellation`,
          at: ctx.now,
          data: {
            order_id: order.id,
            external_id: order.externalId,
            order_name: order.name,
            mode: 'agent_cancel',
            attempt_id: ctx.attempt.id,
          },
        });
      },
    };
  }

  // decision.kind === 'ticket' — the team does it (E-85, invariant 14)
  const ticketId = await createTicket(ctx.tx, {
    tenantId: ctx.tenantId,
    attemptId: ctx.attempt.id,
    contactId: ctx.attempt.contactId,
    orderId: order.id,
    category: 'cancellation',
    summary: `Caller asked by phone to cancel order ${order.name}${reason === null ? '' : ` (reason: ${reason})`}. Not cancelled automatically: ${decision.reason.replace(/_/g, ' ')}.`,
    callbackRequested: false,
    preferredTime: null,
    source: 'agent',
    at: ctx.now,
    actor: { type: 'agent', id: ctx.attempt.id },
  });
  const cancelled = await cancelRedundantCodCall(ctx, order, 'cancellation_requested_on_inbound');
  await emitMerchantEvent(ctx.tx, ctx.tenantId, {
    type: 'order.cancellation_requested',
    eventId: `${ctx.actionId}:cancellation`,
    at: ctx.now,
    data: {
      order_id: order.id,
      external_id: order.externalId,
      order_name: order.name,
      mode: 'ticket',
      reason: decision.reason,
      ticket_id: ticketId,
      cancelled_intents: cancelled,
    },
  });
  const say =
    decision.reason === 'shipped'
      ? `Order ${view.order_ref} has already shipped, so I can't cancel it here. I've asked the team to help — they may arrange a return.`
      : decision.reason === 'prepaid'
        ? `Because order ${view.order_ref} is prepaid, the team needs to cancel it and process the refund. I've passed it to them.`
        : `I've passed your cancellation request for order ${view.order_ref} to the team. They'll confirm it with you.`;
  return {
    status: 'ticketed',
    orderId: order.id,
    ticketId,
    parentActionId: step1.id,
    result: ok({ cancellation: 'requested', reason: decision.reason, ticket_id: ticketId }, say),
  };
};

const requestAddressChange: Handler<'request_address_change'> = async (ctx, args) => {
  const order = await discussableOrder(ctx, args.order_ref);
  if (order === null) return needVerification(ctx);
  // Invariant 14 / E-44 / E-96: the agent never writes an address — the team confirms it.
  const ticketId = await createTicket(ctx.tx, {
    tenantId: ctx.tenantId,
    attemptId: ctx.attempt.id,
    contactId: ctx.attempt.contactId,
    orderId: order.id,
    category: 'address_change',
    summary: `Address change requested by phone for order ${order.name}: ${args.new_address_summary}`,
    callbackRequested: false,
    preferredTime: null,
    source: 'agent',
    at: ctx.now,
    actor: { type: 'agent', id: ctx.attempt.id },
  });
  const shipped = isShipped(facts(order));
  return {
    status: 'ticketed',
    orderId: order.id,
    ticketId,
    result: ok(
      { address_change: 'requested', already_shipped: shipped, ticket_id: ticketId },
      shipped
        ? "I've passed the new address to the team. As the order has already shipped, they'll check what's possible with the courier."
        : "I've passed the new address to the team. They'll confirm it before the order ships.",
    ),
  };
};

const createTicketTool: Handler<'create_ticket'> = async (ctx, args) => {
  const [count] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.attemptId, ctx.attempt.id));
  if ((count?.n ?? 0) >= MAX_TICKETS_PER_CALL) {
    // E-90: a caller cannot flood the merchant's queue from one call.
    return {
      status: 'refused',
      result: fail(
        { created: false, reason: 'ticket_limit' },
        "I've already noted your requests for the team on this call.",
      ),
    };
  }
  let orderId: string | null = null;
  let summary = args.summary;
  if (args.order_ref !== undefined) {
    const order = await discussableOrder(ctx, args.order_ref);
    if (order !== null) orderId = order.id;
    // An unverified reference goes in the text, marked as such — never linked to someone's order.
    else
      summary = `${summary} (order reference given by caller, not verified: ${sanitiseMerchantText(args.order_ref, 40)})`;
  }
  const callbackPossible = ctx.attempt.contactId !== null;
  const ticketId = await createTicket(ctx.tx, {
    tenantId: ctx.tenantId,
    attemptId: ctx.attempt.id,
    contactId: ctx.attempt.contactId,
    orderId,
    category: args.category,
    summary,
    callbackRequested: args.callback_requested && callbackPossible,
    preferredTime: args.preferred_time ?? null,
    source: 'agent',
    at: ctx.now,
    actor: { type: 'agent', id: ctx.attempt.id },
  });
  const say =
    args.callback_requested && !callbackPossible
      ? "I've noted this for the team. Your number is hidden, so they can't call you back — please call us again if you don't hear from us."
      : args.callback_requested
        ? "I've noted this and asked the team to call you back."
        : "I've noted this for the team; they'll follow up.";
  return {
    status: 'ticketed',
    orderId,
    ticketId,
    result: ok({ created: true, ticket_id: ticketId, callback_possible: callbackPossible }, say),
  };
};

const transferToHuman: Handler<'transfer_to_human'> = async (ctx, args) => {
  const profile = ctx.profile;
  const refuse = (
    reason: 'no_target' | 'not_verified' | 'after_hours' | 'already_transferring',
    hours: string,
  ): HandlerOutcome => ({
    status: 'refused',
    result: fail(
      {
        transfer: false,
        reason: reason === 'not_verified' ? 'no_target' : reason,
        hours: hours.length > 0 ? hours : null,
        can_create_ticket: ctx.tools.includes('create_ticket'),
      },
      reason === 'after_hours' && hours.length > 0
        ? `Our team is available ${hours}. I can arrange a call back.`
        : reason === 'already_transferring'
          ? 'I am already connecting you.'
          : 'No one is available to take the call right now. I can arrange a call back.',
    ),
  });
  if (ctx.attempt.status === 'TRANSFERRING') return refuse('already_transferring', '');
  if (profile === null) return refuse('no_target', '');
  const hours = profileHours(profile);
  const text = hoursText(profile);
  const target = await loadTransferTarget(ctx.tx, profile.transferTargetId);
  if (hours === null) return refuse(target === null ? 'no_target' : 'after_hours', text);
  // Invariant 19 / E-86: there is no argument that could carry a number; the target is the profile's.
  const decision = transferPolicy(
    target === null
      ? null
      : {
          id: target.id,
          active: target.active,
          verifiedAt: target.verifiedAt,
          hours: targetHours(target),
        },
    hours,
    ctx.now,
  );
  if (!decision.transfer || target === null)
    return refuse(decision.transfer ? 'no_target' : decision.reason, text);

  let toE164: string;
  try {
    toE164 = decryptPhone(target.phoneEnc, ctx.deps.keys.staffPrivateKeyPem);
  } catch {
    return refuse('no_target', text);
  }
  await ctx.tx
    .update(schema.callAttempts)
    .set({ transferTargetId: target.id, lastEventAt: ctx.now })
    .where(eq(schema.callAttempts.id, ctx.attempt.id));
  await audit(ctx.tx, {
    tenantId: ctx.tenantId,
    actorType: 'agent',
    actorId: ctx.attempt.id,
    action: 'attempt.transfer_requested',
    targetType: 'call_attempt',
    targetId: ctx.attempt.id,
    after: { transfer_target_id: target.id, to_masked: target.phoneMasked },
  });
  return {
    status: 'ok',
    result: {
      ok: true,
      data: { transfer: true, to: target.label },
      say: 'Connecting you now, please hold.',
      action: { kind: 'transfer', toE164, warmSummary: sanitiseMerchantText(args.reason, 200) },
    },
    stored: { transfer: true, transfer_target_id: target.id, to_masked: target.phoneMasked },
  };
};

const registerOptOut: Handler<'register_opt_out'> = async (ctx) => {
  if (ctx.attempt.phoneHash === null) {
    return {
      status: 'refused',
      result: fail(
        { opted_out: false, reason: 'number_withheld' },
        "Your number is hidden, so I can't register it. Please call from the number you'd like us to stop calling.",
      ),
    };
  }
  // E-95: suppresses OUTBOUND calls to this number for this business; answering is unaffected.
  const s = await suppress(ctx.tx, {
    scope: 'tenant',
    tenantId: ctx.tenantId,
    phoneHash: ctx.attempt.phoneHash,
    purpose: 'all',
    reason: 'opt_out',
    at: ctx.now,
    sourceAttemptId: ctx.attempt.id,
    createdBy: `attempt:${ctx.attempt.id}`,
  });
  if (s.created) {
    await audit(ctx.tx, {
      tenantId: ctx.tenantId,
      actorType: 'agent',
      actorId: ctx.attempt.id,
      action: 'suppression.created',
      targetType: 'suppression',
      targetId: s.id,
      after: { reason: 'opt_out', until: s.until?.toISOString() ?? null, source: 'voice_tool' },
    });
    await emitMerchantEvent(ctx.tx, ctx.tenantId, {
      type: 'suppression.created',
      eventId: `${s.id}:created`,
      at: ctx.now,
      data: {
        suppression_id: s.id,
        reason: 'opt_out',
        until: s.until?.toISOString() ?? null,
        external_ref: null,
      },
    });
  }
  return {
    status: 'ok',
    result: ok(
      { opted_out: true },
      "Done — this business won't call your number again. You can still call us any time.",
    ),
  };
};

export const HANDLERS: { readonly [T in ToolName]: Handler<T> } = {
  lookup_orders: lookupOrders,
  verify_caller: verifyCallerTool,
  search_knowledge: searchKnowledgeTool,
  confirm_order: confirmOrder,
  request_cancellation: requestCancellation,
  request_address_change: requestAddressChange,
  create_ticket: createTicketTool,
  transfer_to_human: transferToHuman,
  register_opt_out: registerOptOut,
};
