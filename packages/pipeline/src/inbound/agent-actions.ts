import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import { newId } from '@naaradh/shared';
import { scrub } from '../audit.js';

/**
 * The append-only record of what the voice agent did (invariant 18). Every tool call — refused
 * or not — is a row. Args are scrubbed before storage: identity factors and free-text that can
 * carry an address never land here (they live, where needed, in the ticket).
 */

export type AgentActionStatus = (typeof schema.agentActionStatus.enumValues)[number];

/** Keys removed from stored args on top of the audit scrubber's PII list. */
const ACTION_SECRET_KEYS = new Set([
  'pincode',
  'new_address_summary',
  'summary',
  'preferred_time',
  'confirm_token',
]);

export function scrubArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = ACTION_SECRET_KEYS.has(k)
      ? v === undefined || v === null || v === ''
        ? v
        : '[redacted]'
      : v;
  }
  return scrub(out) as Record<string, unknown>;
}

export interface RecordActionInput {
  /** Pre-generated when a dependent row (order_actions) must reference this action. */
  readonly id?: string;
  readonly tenantId: string;
  readonly attemptId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: AgentActionStatus;
  readonly result: Readonly<Record<string, unknown>>;
  readonly orderId?: string | null;
  readonly ticketId?: string | null;
  readonly parentActionId?: string | null;
  readonly toolCallId?: string | null;
  readonly confirmTokenHash?: string | null;
  readonly tokenExpiresAt?: Date | null;
  readonly latencyMs?: number | null;
  readonly at: Date;
}

export async function recordAgentAction(tx: DbOrTx, input: RecordActionInput): Promise<string> {
  const id = input.id ?? newId('agentAction');
  await tx.insert(schema.agentActions).values({
    id,
    tenantId: input.tenantId,
    attemptId: input.attemptId,
    tool: input.tool,
    args: scrubArgs(input.args),
    status: input.status,
    result: scrub(input.result) as Record<string, unknown>,
    orderId: input.orderId ?? null,
    ticketId: input.ticketId ?? null,
    parentActionId: input.parentActionId ?? null,
    toolCallId: input.toolCallId ?? null,
    confirmTokenHash: input.confirmTokenHash ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    latencyMs: input.latencyMs ?? null,
    at: input.at,
  });
  return id;
}

/** A single-use confirmation token (E-84): the model sees the token, the database sees its hash. */
export function newConfirmToken(): { token: string; hash: string } {
  const token = `ct_${randomBytes(18).toString('base64url')}`;
  return { token, hash: hashConfirmToken(token) };
}

export function hashConfirmToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The step-1 row a token belongs to, on THIS call only. */
export async function findConfirmation(tx: DbOrTx, attemptId: string, tokenHash: string) {
  const [row] = await tx
    .select({
      id: schema.agentActions.id,
      tool: schema.agentActions.tool,
      orderId: schema.agentActions.orderId,
      tokenExpiresAt: schema.agentActions.tokenExpiresAt,
      status: schema.agentActions.status,
    })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.attemptId, attemptId),
        eq(schema.agentActions.confirmTokenHash, tokenHash),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** E-89 for tools: the engine retried an invocation we already handled — replay, never redo. */
export async function findToolReplay(tx: DbOrTx, attemptId: string, toolCallId: string) {
  const [row] = await tx
    .select({
      id: schema.agentActions.id,
      tool: schema.agentActions.tool,
      status: schema.agentActions.status,
      result: schema.agentActions.result,
    })
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.attemptId, attemptId),
        eq(schema.agentActions.toolCallId, toolCallId),
      ),
    )
    .limit(1);
  return row ?? null;
}
