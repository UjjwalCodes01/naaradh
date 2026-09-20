import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { and, eq, isNull, or } from 'drizzle-orm';
import { schema, withTenant, type Tx } from '@naaradh/db';
import type { ToolCallRequest, ToolResult } from '@naaradh/engines-core';
import { isVendor } from '@naaradh/engines-registry';
import { findToolReplay, recordAgentAction } from '@naaradh/pipeline';
import { OUTBOUND_TOOLS, ToolArgs, isToolName, type ToolName } from '@naaradh/call-scripts';
import { SignatureInvalidError, newId, verifyVoiceToolTag } from '@naaradh/shared';
import type { VoiceDeps } from '../context.js';
import { bodyOf, headersOf, httpInfoOf, isUniqueViolation } from '../http.js';
import { activeProfileForTenant, enabledTools, loadProfile, type ProfileRow } from '../profiles.js';
import { HANDLERS } from './handlers.js';
import { fail, type HandlerOutcome, type ToolAttempt, type ToolCtx } from './types.js';

/**
 * POST /tools/:vendor/:tenantTag/:tool — the agent invoked one of our tools mid-call
 * (AGENTS §5.9, invariant 18). In order:
 *
 *   signature → tenant from the URL tag → attempt from the vendor call id (never the payload's
 *   say-so) → live? → replay? → tool enabled for THIS call → Zod args → handler → agent_actions
 *
 * Every outcome the agent can act on is HTTP 200 with `ok:false` and a sentence to say; only
 * authentication failures are HTTP errors. Budget: < 700 ms p95 (E-93).
 */
export function registerToolRoutes(app: FastifyInstance, deps: VoiceDeps): void {
  app.post<{ Params: { vendor: string; tenantTag: string; tool: string } }>(
    '/tools/:vendor/:tenantTag/:tool',
    async (request, reply) => {
      const { vendor, tenantTag, tool } = request.params;
      if (!isVendor(vendor)) return reply.code(404).send({ error: 'not found' });
      const tenantId = verifyVoiceToolTag(deps.engineWebhookKey, vendor, tenantTag);
      // A bad tag looks exactly like a bad URL: no oracle for guessing tags.
      if (tenantId === null) return reply.code(404).send({ error: 'not found' });
      const adapter = deps.registry.get(vendor);

      let call: ToolCallRequest;
      try {
        call = adapter.parseToolCall(
          headersOf(request.headers),
          bodyOf(request.body),
          httpInfoOf(request),
        );
      } catch (error) {
        if (error instanceof SignatureInvalidError) {
          request.log.warn({ vendor, tenant_id: tenantId }, 'tool call rejected: bad signature');
          return reply.code(401).send({ error: 'invalid signature' });
        }
        request.log.warn({ err: error, vendor }, 'tool call unparseable');
        return reply.code(400).send({ error: 'unparseable' });
      }
      if (call.tool !== tool) return reply.code(400).send({ error: 'tool mismatch' });

      const started = Date.now();
      const { result, attemptId } = await runTool(
        deps,
        vendor,
        tenantId,
        call,
        request.log,
        started,
      );
      const res = adapter.formatToolResult(result);
      request.log.info(
        {
          vendor,
          tenant_id: tenantId,
          attempt_id: attemptId,
          tool,
          ok: result.ok,
          ms: Date.now() - started,
        },
        'tool call',
      );
      return reply.code(res.status).headers(res.headers).send(res.body);
    },
  );
}

const TERMINAL = new Set([
  'ENDED',
  'NO_ANSWER',
  'BUSY',
  'AMD_HANGUP',
  'AMD_MESSAGE_LEFT',
  'FAILED',
  'CANCELLED',
]);

const TEMPORARY_FAILURE: ToolResult = fail(
  { error: 'temporary_failure' },
  "Sorry, I'm having trouble checking that right now. I can ask the team to call you back.",
);

async function runTool(
  deps: VoiceDeps,
  vendor: string,
  tenantId: string,
  call: ToolCallRequest,
  log: FastifyBaseLogger,
  started: number,
): Promise<{ result: ToolResult; attemptId: string | null }> {
  if (!isToolName(call.tool)) return { result: fail({ error: 'unknown_tool' }), attemptId: null };
  const tool = call.tool;
  let attemptId: string | null = null;
  try {
    const result = await withTenant(deps.db, tenantId, async (tx) => {
      const attempt = await findAttempt(tx, vendor, call);
      if (attempt === null) return fail({ error: 'call_not_found' });
      attemptId = attempt.id;
      if (TERMINAL.has(attempt.status)) return fail({ error: 'call_ended' });

      // E-89 for tools: the engine retried an invocation — replay what we said, never redo it.
      const replay = await findToolReplay(tx, attempt.id, call.toolCallId);
      if (replay !== null) return replayResult(replay.result);

      const profile = await profileFor(tx, tenantId, attempt);
      const tools = toolsFor(attempt, profile);
      const actionId = newId('agentAction');
      const now = deps.clock.now();
      const record = (outcome: HandlerOutcome) =>
        recordAgentAction(tx, {
          id: actionId,
          tenantId,
          attemptId: attempt.id,
          tool,
          args: call.args,
          status: outcome.status,
          result: {
            ok: outcome.result.ok,
            data: outcome.stored ?? outcome.result.data,
            say: outcome.result.say,
            action: outcome.result.action?.kind ?? null,
          },
          orderId: outcome.orderId ?? null,
          ticketId: outcome.ticketId ?? null,
          parentActionId: outcome.parentActionId ?? null,
          toolCallId: call.toolCallId,
          confirmTokenHash: outcome.confirmTokenHash ?? null,
          tokenExpiresAt: outcome.tokenExpiresAt ?? null,
          latencyMs: Date.now() - started,
          at: now,
        });

      if (!tools.includes(tool)) {
        const refused: HandlerOutcome = {
          status: 'refused',
          result: fail({ error: 'tool_not_available' }, "I'm not able to do that on this call."),
        };
        await record(refused);
        return refused.result;
      }
      const parsed = ToolArgs[tool].safeParse(call.args);
      if (!parsed.success) {
        // Paths only — never echo the values back (they are the caller's words).
        const refused: HandlerOutcome = {
          status: 'refused',
          result: fail({
            error: 'invalid_arguments',
            fields: parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
          }),
        };
        await record(refused);
        return refused.result;
      }

      const ctx: ToolCtx = { tx, deps, tenantId, vendor, now, actionId, attempt, profile, tools };
      const outcome = await (HANDLERS[tool] as (c: ToolCtx, a: unknown) => Promise<HandlerOutcome>)(
        ctx,
        parsed.data,
      );
      await record(outcome);
      if (outcome.after !== undefined) await outcome.after();
      return outcome.result;
    });
    return { result, attemptId };
  } catch (error) {
    if (isUniqueViolation(error, 'agent_actions_tool_call_uq')) {
      // A concurrent retry of the same invocation won the insert: answer with its result.
      const replayed = await withTenant(deps.db, tenantId, async (tx) => {
        const attempt = await findAttempt(tx, vendor, call);
        const row = attempt === null ? null : await findToolReplay(tx, attempt.id, call.toolCallId);
        return row === null ? TEMPORARY_FAILURE : replayResult(row.result);
      }).catch(() => TEMPORARY_FAILURE);
      return { result: replayed, attemptId };
    }
    if (isUniqueViolation(error, 'agent_actions_token_spent_once')) {
      return {
        result: fail(
          { cancelled: false, reason: 'token_used' },
          'That cancellation has already been submitted.',
        ),
        attemptId,
      };
    }
    log.error({ err: error, tenant_id: tenantId, tool }, 'tool call failed');
    return { result: TEMPORARY_FAILURE, attemptId };
  }
}

/**
 * The attempt is found by the vendor's call id within the URL's tenant. The echoed attempt id
 * is accepted only while the engine call id is not yet recorded (the first seconds of an
 * outbound call) — so a payload cannot point a tool at another call.
 */
async function findAttempt(
  tx: Tx,
  vendor: string,
  call: ToolCallRequest,
): Promise<ToolAttempt | null> {
  const byCall = eq(schema.callAttempts.engineCallId, call.vendorCallId);
  const byId =
    call.attemptId === null
      ? undefined
      : and(eq(schema.callAttempts.id, call.attemptId), isNull(schema.callAttempts.engineCallId));
  const [row] = await tx
    .select({
      id: schema.callAttempts.id,
      direction: schema.callAttempts.direction,
      status: schema.callAttempts.status,
      contactId: schema.callAttempts.contactId,
      phoneHash: schema.callAttempts.phoneHash,
      intentId: schema.callAttempts.intentId,
      callerVerification: schema.callAttempts.callerVerification,
      verifiedOrderIds: schema.callAttempts.verifiedOrderIds,
      verifyFailures: schema.callAttempts.verifyFailures,
      transferTargetId: schema.callAttempts.transferTargetId,
      inboundProfileId: schema.callAttempts.inboundProfileId,
    })
    .from(schema.callAttempts)
    .where(
      and(eq(schema.callAttempts.engine, vendor), byId === undefined ? byCall : or(byCall, byId)),
    )
    .limit(1);
  return row ?? null;
}

async function profileFor(
  tx: Tx,
  tenantId: string,
  attempt: ToolAttempt,
): Promise<ProfileRow | null> {
  if (attempt.direction === 'inbound')
    return attempt.inboundProfileId === null ? null : loadProfile(tx, attempt.inboundProfileId);
  return activeProfileForTenant(tx, tenantId);
}

/** Inbound: what the profile enables. Outbound: that, minus inbound-only tools; nothing without a profile. */
function toolsFor(attempt: ToolAttempt, profile: ProfileRow | null): ToolName[] {
  if (profile === null) return [];
  const enabled = enabledTools(profile);
  return attempt.direction === 'inbound'
    ? enabled
    : enabled.filter((t) => OUTBOUND_TOOLS.includes(t));
}

function replayResult(stored: unknown): ToolResult {
  const s = (stored ?? {}) as { ok?: unknown; data?: unknown; say?: unknown };
  return {
    ok: s.ok === true,
    data: {
      ...(typeof s.data === 'object' && s.data !== null ? (s.data as Record<string, unknown>) : {}),
      replayed: true,
    },
    say: typeof s.say === 'string' ? s.say : null,
    // A replay never re-issues a call action (a second transfer) or a secret (a token).
    action: null,
  };
}
