import { schema, type DbOrTx } from '@naaradh/db';
import { sanitiseMerchantText } from '@naaradh/scripts';
import { newId } from '@naaradh/shared';
import { audit, type ActorType } from '../audit.js';
import { emitMerchantEvent } from '../outbox.js';

/**
 * Support tickets: everything the merchant must do because the agent may not (E-85, E-87,
 * E-91, E-96). The summary is written by the agent from what the caller said, so it is data:
 * control and format characters are stripped and it is capped. It can contain personal data
 * (a new address), so it stays in the ticket and the dashboard — the merchant WEBHOOK carries
 * only the ticket id, category and flags (PII-minimised outbox).
 */

export type TicketCategory = (typeof schema.ticketCategory.enumValues)[number];

export interface CreateTicketInput {
  readonly tenantId: string;
  readonly attemptId: string | null;
  readonly contactId: string | null;
  readonly orderId: string | null;
  readonly category: TicketCategory;
  readonly summary: string;
  readonly callbackRequested: boolean;
  readonly preferredTime: string | null;
  readonly source: 'agent' | 'api' | 'dashboard';
  readonly priority?: number;
  readonly at: Date;
  readonly actor: { type: ActorType; id?: string };
}

/** Same sanitiser as merchant variables (E-72): control/format characters out, whitespace folded. */
export function cleanSummary(text: string, max = 1000): string {
  return sanitiseMerchantText(text, max).replace(/\s+/g, ' ').trim();
}

/** Money and address issues first; a callback request next; the rest after. */
export function ticketPriority(category: TicketCategory, callbackRequested: boolean): number {
  if (
    category === 'refund' ||
    category === 'cancellation' ||
    category === 'address_change' ||
    category === 'complaint'
  )
    return 80;
  return callbackRequested ? 60 : 40;
}

export async function createTicket(tx: DbOrTx, input: CreateTicketInput): Promise<string> {
  const id = newId('ticket');
  const summary = cleanSummary(input.summary) || '(no summary)';
  await tx.insert(schema.supportTickets).values({
    id,
    tenantId: input.tenantId,
    attemptId: input.attemptId,
    contactId: input.contactId,
    orderId: input.orderId,
    category: input.category,
    summary,
    callbackRequested: input.callbackRequested,
    preferredTime: input.preferredTime === null ? null : cleanSummary(input.preferredTime, 80),
    status: 'open',
    source: input.source,
    priority: input.priority ?? ticketPriority(input.category, input.callbackRequested),
  });
  await audit(tx, {
    tenantId: input.tenantId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: 'ticket.created',
    targetType: 'support_ticket',
    targetId: id,
    after: {
      category: input.category,
      callback_requested: input.callbackRequested,
      attempt_id: input.attemptId,
      order_id: input.orderId,
    },
  });
  await emitMerchantEvent(tx, input.tenantId, {
    type: 'ticket.created',
    eventId: `${id}:created`,
    at: input.at,
    data: {
      ticket_id: id,
      category: input.category,
      callback_requested: input.callbackRequested,
      attempt_id: input.attemptId,
      order_id: input.orderId,
    },
  });
  return id;
}
