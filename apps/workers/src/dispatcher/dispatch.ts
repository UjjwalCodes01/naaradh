import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, withTenant, type Tx } from '@naaradh/db';
import {
  buildGateDeps,
  cachedDnd,
  gateIntent,
  loadGateInput,
  openCircuit,
  reasonInfo,
  refreshDnd,
  type GateFail,
  type GatePass,
} from '@naaradh/compliance';
import {
  EngineDispatchUncertain,
  EngineRateLimited,
  EngineUnavailable,
  type AgentSpec,
  type EngineAgentRef,
  type Locale,
} from '@naaradh/engines-core';
import { audit, emitMerchantEvent } from '@naaradh/pipeline';
import {
  OUTBOUND_TOOLS,
  TOOL_RULES,
  renderScript,
  extractionJsonSchema,
  toolDefinitions,
  validateScript,
} from '@naaradh/scripts';
import { addMinutes, decryptPhone, engineWebhookPath, newId, voiceToolPath } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';

/**
 * The dispatcher (AGENTS §5.3), per claimed intent:
 *
 *   1. gate — inside the tenant transaction; a refusal is persisted with its trace
 *   2. attempt row — COMMITTED before the engine is called (crash between the two leaves
 *      evidence, never a phantom call)
 *   3. placeCall — outside any transaction
 *   4. record the engine's answer — DIALING, or the specific failure the engine classified
 *
 * Nothing here decides whether to call. That is the gate's job, and the dispatcher uses
 * exactly what the gate returned: engine, CLI, script, AMD mode, max duration.
 */

/** Delay before a vendor-side hiccup is retried, by the error the adapter classified. */
const RETRY_AFTER_MINUTES = { unavailable: 1, unknown: 5 } as const;
const CIRCUIT_FAILURES_TO_OPEN = 5;
const CIRCUIT_OPEN_SEC = 60;

export type DispatchOutcome =
  | { kind: 'dialing'; attemptId: string; engineCallId: string }
  | { kind: 'gated'; reason: string; retryAt: Date | null }
  | { kind: 'cancelled' }
  | { kind: 'uncertain'; attemptId: string }
  | { kind: 'engine_error'; attemptId: string; code: string }
  | { kind: 'not_claimed' };

export async function dispatchIntent(
  ctx: WorkerContext,
  intentId: string,
  tenantId: string,
): Promise<DispatchOutcome> {
  const now = ctx.clock.now();

  // ---- Phase 0: DND scrub, OUTSIDE any transaction -----------------------------------------
  // The provider is a network call and Phase A holds the intent row: a slow scrub must never
  // hold a Postgres transaction open (the same rule the Shopify write-back follows). The gate
  // then reads the cache this filled; an empty cache fails closed (`dnd:unknown`).
  await scrubDndBeforeGate(ctx, intentId, tenantId, now);

  // ---- Phase A: gate + attempt row, one tenant transaction ---------------------------------
  const phaseA = await withTenant(
    ctx.app,
    tenantId,
    async (tx): Promise<{ kind: 'proceed'; plan: DialPlan } | DispatchOutcome> => {
      const loaded = await loadGateInput(tx, intentId);
      const [row] = await tx
        .select({
          status: schema.callIntents.status,
          cancelledAt: schema.callIntents.cancelledAt,
          variables: schema.callIntents.variables,
          attemptsCount: schema.callIntents.attemptsCount,
        })
        .from(schema.callIntents)
        .where(eq(schema.callIntents.id, intentId))
        .limit(1);
      if (row === undefined || row.status !== 'DISPATCHING') return { kind: 'not_claimed' };

      if (row.cancelledAt !== null) {
        await tx
          .update(schema.callIntents)
          .set({ status: 'CANCELLED', claimedAt: null, claimedBy: null, nextAttemptAt: null })
          .where(eq(schema.callIntents.id, intentId));
        return { kind: 'cancelled' };
      }

      const deps = buildGateDeps(tx, ctx.redis, ctx.gate, loaded.tenantZone, now);
      const result = await gateIntent(
        { tenant: loaded.tenant, contact: loaded.contact, intent: loaded.intent, now },
        deps,
      );

      if (!result.ok) {
        await recordGateFailure(tx, tenantId, loaded.intent, result, now);
        return { kind: 'gated', reason: result.reason, retryAt: result.retryAt };
      }

      const plan = await prepareDial(
        ctx,
        tx,
        tenantId,
        loaded,
        row.variables as Record<string, string>,
        row.attemptsCount,
        result,
        now,
      );
      if (plan === null) {
        await result.lease.release();
        await recordGateFailure(
          tx,
          tenantId,
          loaded.intent,
          { ok: false, reason: 'script:none_approved', retryAt: null, trace: result.trace },
          now,
        );
        return { kind: 'gated', reason: 'script:none_approved', retryAt: null };
      }
      return { kind: 'proceed', plan };
    },
  );
  if (phaseA.kind !== 'proceed') return phaseA;
  const { plan } = phaseA;

  // ---- Phase B: the call, outside any transaction --------------------------------------------
  const adapter = ctx.registry.get(plan.engine);
  try {
    const agentRef = await ensureAgent(ctx, plan);
    const ref = await adapter.placeCall({
      to: plan.to,
      from: plan.from,
      agentRef,
      variables: plan.slots,
      maxDurationSec: plan.maxDurationSec,
      metadata: {
        tenant_id: tenantId,
        campaign_id: plan.campaignId,
        call_id: plan.attemptId,
        purpose: plan.purpose,
        script_version: String(plan.scriptVersion),
      },
      webhookUrl: `${ctx.hooksBaseUrl}${engineWebhookPath(ctx.engineWebhookKey, plan.engine, tenantId)}`,
      amd: plan.amdMode,
      locale: plan.locale,
      idempotencyKey: plan.attemptId,
    });
    await withTenant(ctx.app, tenantId, async (tx) => {
      await tx
        .update(schema.callAttempts)
        .set({
          status: sql`case when status = 'DISPATCHING' then 'DIALING'::attempt_status else status end`,
          engineCallId: ref.callId,
          engineAgentId: agentRef.agentId,
          dispatchedAt: now,
          lastEventAt: now,
        })
        .where(eq(schema.callAttempts.id, plan.attemptId));
      await tx.execute(sql`select touch_number(${plan.numberId}, ${now})`);
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'attempt.dialing',
        targetType: 'call_attempt',
        targetId: plan.attemptId,
        after: { engine: plan.engine, engine_call_id: ref.callId },
      });
      await emitMerchantEvent(tx, tenantId, {
        type: 'call.started',
        eventId: `${plan.attemptId}:started`,
        at: now,
        data: {
          intent_id: intentId,
          attempt_id: plan.attemptId,
          attempt_no: plan.attemptNo,
          external_refs: plan.externalRefs,
        },
      });
    });
    await ctx.redis.del(`circuit_fail:${plan.engine}`);
    return { kind: 'dialing', attemptId: plan.attemptId, engineCallId: ref.callId };
  } catch (error) {
    return handleDispatchError(ctx, tenantId, intentId, plan, error, now);
  }
}

interface DialPlan {
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly engine: string;
  readonly to: string;
  readonly from: string;
  readonly numberId: string;
  readonly slots: Record<string, string>;
  readonly maxDurationSec: number;
  readonly amdMode: GatePass['amdMode'];
  readonly locale: Locale;
  readonly purpose: string;
  readonly campaignId: string | null;
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly agentSpec: AgentSpec;
  /** Tool set identity — a profile change must not reuse an agent created with the old tools. */
  readonly agentKey: string;
  readonly externalRefs: string[];
  readonly notAfter: Date;
}

/**
 * Promotional calls need a fresh DND answer (gate step 8, ADR-0010 §6). The provider needs the
 * plaintext number, which only the dispatcher can decrypt, so the scrub happens here — and
 * deliberately NOT inside the gate transaction: an unresponsive provider would otherwise hold
 * the intent row for its whole timeout.
 *
 * Reads and writes touch `dnd_scrub_cache`, which is global and carries no RLS policy, so the
 * cache write needs no tenant context. Everything else is read in one short transaction.
 * Failures are swallowed: no answer means the gate refuses (`dnd:unknown`), which is the
 * conservative outcome anyway.
 */
async function scrubDndBeforeGate(
  ctx: WorkerContext,
  intentId: string,
  tenantId: string,
  now: Date,
): Promise<void> {
  const provider = ctx.dnd;
  if (provider === undefined || provider.name === 'none' || ctx.keys.privateKeyPem === null) return;
  const subject = await withTenant(ctx.app, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        purpose: schema.callIntents.purpose,
        phoneHash: schema.callIntents.phoneHash,
        region: schema.callIntents.recipientRegion,
        phoneEnc: schema.contacts.phoneEnc,
      })
      .from(schema.callIntents)
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.callIntents.contactId))
      .where(eq(schema.callIntents.id, intentId))
      .limit(1);
    if (row === undefined || row.purpose !== 'promotional' || row.phoneEnc === null) return null;
    if ((await cachedDnd(tx, row.phoneHash, now)) !== null) return null;
    return row;
  });
  if (subject === null || subject.phoneEnc === null) return;
  try {
    const e164 = decryptPhone(subject.phoneEnc, ctx.keys.privateKeyPem);
    await refreshDnd(ctx.app, provider, subject.phoneHash, e164, subject.region, now);
  } catch (error) {
    ctx.log.warn({ err: error, intent_id: intentId }, 'DND scrub failed; the gate will refuse');
  }
}

async function prepareDial(
  ctx: WorkerContext,
  tx: Tx,
  tenantId: string,
  loaded: Awaited<ReturnType<typeof loadGateInput>>,
  variables: Record<string, string>,
  attemptsCount: number,
  pass: GatePass,
  now: Date,
): Promise<DialPlan | null> {
  const [script] = await tx
    .select({ body: schema.scripts.body })
    .from(schema.scripts)
    .where(eq(schema.scripts.id, pass.script.id))
    .limit(1);
  if (script === undefined) return null;
  const validated = validateScript(script.body);
  if (!validated.ok) {
    // Approved-but-invalid cannot happen through the API; if it does, refuse to dial (invariant 7).
    ctx.log.error(
      { script_id: pass.script.id, errors: validated.errors },
      'approved script fails validation',
    );
    return null;
  }
  const [contact] = await tx
    .select({ phoneEnc: schema.contacts.phoneEnc })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, loaded.contact.id))
    .limit(1);
  if (
    contact?.phoneEnc === null ||
    contact?.phoneEnc === undefined ||
    ctx.keys.privateKeyPem === null
  )
    return null;

  // The ONLY place a dialable number exists in memory, for the duration of one placeCall.
  const to = decryptPhone(contact.phoneEnc, ctx.keys.privateKeyPem);

  const [tenant] = await tx
    .select({ name: schema.tenants.name })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  const slots = { brand: tenant?.name ?? 'the store', ...variables };
  const rendered = renderScript(validated.template, slots, {
    recordingConsent: pass.recordingConsent,
  });

  // ADR-0006: the outbound agent carries the same mid-call tools as the support line (order
  // lookup, cancellation, tickets, transfer) when the tenant runs one — settings come from it.
  const [profile] = await tx
    .select({
      id: schema.inboundProfiles.id,
      version: schema.inboundProfiles.version,
      toolsEnabled: schema.inboundProfiles.toolsEnabled,
    })
    .from(schema.inboundProfiles)
    .where(
      and(
        eq(schema.inboundProfiles.tenantId, tenantId),
        eq(schema.inboundProfiles.status, 'active'),
      ),
    )
    .orderBy(desc(schema.inboundProfiles.updatedAt))
    .limit(1);
  // Product code branches on capabilities, never on vendor: an engine that cannot put a call
  // through to a number we choose must not be told it can (the agent would promise a transfer).
  const caps = ctx.registry.get(pass.engine).capabilities();
  const toolNames =
    profile === undefined || !caps.midCallTools
      ? // No tools on an engine that cannot call them: the prompt must not promise lookups.
        []
      : OUTBOUND_TOOLS.filter(
          (t) =>
            profile.toolsEnabled.includes(t) && (t !== 'transfer_to_human' || caps.warmTransfer),
        );
  const tools = toolDefinitions({
    tools: toolNames,
    locale: loaded.intent.locale,
    urlFor: (t) =>
      `${ctx.voiceBaseUrl}${voiceToolPath(ctx.engineWebhookKey, pass.engine, tenantId, t)}`,
  });
  const systemPrompt =
    toolNames.length === 0
      ? rendered.systemPrompt
      : [rendered.systemPrompt, ...toolNames.map((t) => TOOL_RULES[t])].join('\n');
  const attemptId = newId('attempt');
  const attemptNo = attemptsCount + 1;
  const [intentRow] = await tx
    .select({ externalRefs: schema.callIntents.externalRefs })
    .from(schema.callIntents)
    .where(eq(schema.callIntents.id, loaded.intent.id))
    .limit(1);

  await tx.insert(schema.callAttempts).values({
    id: attemptId,
    tenantId,
    intentId: loaded.intent.id,
    contactId: loaded.contact.id,
    phoneHash: loaded.intent.phoneHash,
    direction: 'outbound',
    purpose: loaded.intent.purpose,
    externalRef: loaded.intent.externalRef,
    attemptNo,
    engine: pass.engine,
    fromE164: pass.cli.e164,
    numberId: pass.cli.id,
    scriptId: pass.script.id,
    scriptVersion: pass.script.version,
    // ADR-0010 §4: the DLT content template this call ran under (CDR mapping).
    dltTemplateId: pass.script.dltTemplateId ?? null,
    amdMode: pass.amdMode,
    maxDurationSec: pass.maxDurationSec,
    idempotencyKey: attemptId,
    status: 'DISPATCHING',
    scheduledAt: now,
    lastEventAt: now,
  });
  await tx
    .update(schema.callIntents)
    .set({
      status: 'IN_PROGRESS',
      attemptsCount: attemptNo,
      scriptId: pass.script.id,
      gatedReason: null,
      gateTrace: pass.trace,
      claimedAt: null,
      claimedBy: null,
      nextAttemptAt: null,
    })
    .where(eq(schema.callIntents.id, loaded.intent.id));
  await audit(tx, {
    tenantId,
    actorType: 'worker',
    actorId: ctx.workerId,
    action: 'intent.gate_passed',
    targetType: 'call_intent',
    targetId: loaded.intent.id,
    after: {
      attempt_id: attemptId,
      engine: pass.engine,
      cli: pass.cli.id,
      script: pass.script.id,
      ab_arm: pass.script.abArm ?? null,
      dlt_template_id: pass.script.dltTemplateId ?? null,
      dial_deadline: pass.dialDeadline.toISOString(),
    },
  });

  return {
    attemptId,
    attemptNo,
    engine: pass.engine,
    to,
    from: pass.cli.e164,
    numberId: pass.cli.id,
    slots: rendered.slots as Record<string, string>,
    maxDurationSec: pass.maxDurationSec,
    amdMode: pass.amdMode,
    locale: loaded.intent.locale as Locale,
    purpose: loaded.intent.purpose,
    campaignId: loaded.intent.campaignId,
    scriptId: pass.script.id,
    scriptVersion: pass.script.version,
    agentSpec: {
      name: `${tenantId}:${loaded.intent.useCase}:${pass.script.locale}:v${String(pass.script.version)}`,
      locale: loaded.intent.locale as Locale,
      systemPrompt,
      // The template, not this customer's rendering: the agent is reused across calls.
      firstUtterance: rendered.firstUtteranceTemplate,
      voiceId: 'default',
      maxDurationSec: pass.maxDurationSec,
      ...(tools.length === 0 ? {} : { tools }),
      webhookUrl: `${ctx.hooksBaseUrl}${engineWebhookPath(ctx.engineWebhookKey, pass.engine, tenantId)}`,
      extraction: {
        name: validated.template.extraction,
        schema: extractionJsonSchema(validated.template.extraction),
      },
    },
    // The opening differs by recording-consent mode, so the cached agent must too.
    agentKey: `${
      profile === undefined || toolNames.length === 0
        ? 'notools'
        : `${profile.id}.v${String(profile.version)}`
    }.rec-${pass.recordingConsent}`,
    externalRefs: intentRow?.externalRefs ?? [loaded.intent.externalRef],
    notAfter: loaded.intent.notAfter,
  };
}

/** Engine agents are created once per (engine, script version) and cached in Redis. */
async function ensureAgent(ctx: WorkerContext, plan: DialPlan): Promise<EngineAgentRef> {
  const key = `agent:${plan.engine}:${plan.scriptId}:${String(plan.scriptVersion)}:${plan.agentKey}`;
  const cached = await ctx.redis.get(key);
  if (cached !== null) return { vendor: plan.engine, agentId: cached };
  const ref = await ctx.registry.get(plan.engine).createAgent(plan.agentSpec);
  await ctx.redis.set(key, ref.agentId, 'EX', 7 * 86_400);
  return ref;
}

async function recordGateFailure(
  tx: Tx,
  tenantId: string,
  intent: { id: string; notAfter: Date },
  result: GateFail,
  now: Date,
): Promise<void> {
  const info = reasonInfo(result.reason);
  const canRetry = info.temporary && result.retryAt !== null && result.retryAt <= intent.notAfter;
  const expired =
    result.reason === 'intent:expired' || result.reason === 'window:transactional_expired';
  const status = canRetry ? 'SCHEDULED' : expired ? 'EXPIRED' : 'GATED';
  await tx
    .update(schema.callIntents)
    .set({
      status,
      gatedReason: result.reason,
      gateTrace: result.trace,
      nextAttemptAt: canRetry ? result.retryAt : null,
      claimedAt: null,
      claimedBy: null,
      ...(status === 'SCHEDULED' ? {} : { completedAt: now }),
    })
    .where(eq(schema.callIntents.id, intent.id));
  await audit(tx, {
    tenantId,
    actorType: 'worker',
    action: canRetry ? 'intent.deferred' : 'intent.gated',
    targetType: 'call_intent',
    targetId: intent.id,
    after: { reason: result.reason, retry_at: result.retryAt?.toISOString() ?? null, status },
  });
  if (!canRetry) {
    await emitMerchantEvent(tx, tenantId, {
      type: 'intent.gated',
      eventId: `${intent.id}:gated:${result.reason}`,
      at: now,
      data: {
        intent_id: intent.id,
        reason: result.reason,
        title: info.title,
        explanation: info.explanation,
        hint: info.hint,
        final: true,
      },
    });
  }
}

async function handleDispatchError(
  ctx: WorkerContext,
  tenantId: string,
  intentId: string,
  plan: DialPlan,
  error: unknown,
  now: Date,
): Promise<DispatchOutcome> {
  const { releaseConcurrency } = await import('@naaradh/compliance');

  if (error instanceof EngineDispatchUncertain) {
    // The call may be live. Keep the lease, keep the attempt, let reconcile find the truth (AGENTS §5.3).
    await withTenant(ctx.app, tenantId, async (tx) => {
      await tx
        .update(schema.callAttempts)
        .set({
          status: 'UNCERTAIN',
          dispatchedAt: now,
          lastEventAt: now,
          error: { code: 'DISPATCH_UNCERTAIN' },
        })
        .where(eq(schema.callAttempts.id, plan.attemptId));
      await audit(tx, {
        tenantId,
        actorType: 'worker',
        actorId: ctx.workerId,
        action: 'attempt.uncertain',
        targetType: 'call_attempt',
        targetId: plan.attemptId,
      });
    });
    return { kind: 'uncertain', attemptId: plan.attemptId };
  }

  let code = 'ENGINE_ERROR';
  let retryAt = addMinutes(now, RETRY_AFTER_MINUTES.unknown);
  if (error instanceof EngineRateLimited) {
    code = 'RATE_LIMITED';
    retryAt = new Date(now.getTime() + (error.retryAfterSec ?? 30) * 1000);
  } else if (error instanceof EngineUnavailable) {
    code = 'ENGINE_UNAVAILABLE';
    retryAt = addMinutes(now, RETRY_AFTER_MINUTES.unavailable);
    const failures = await ctx.redis.incr(`circuit_fail:${plan.engine}`);
    await ctx.redis.expire(`circuit_fail:${plan.engine}`, 60);
    if (failures >= CIRCUIT_FAILURES_TO_OPEN) {
      await openCircuit(ctx.redis, plan.engine, CIRCUIT_OPEN_SEC);
      ctx.log.error({ engine: plan.engine, failures }, 'engine circuit OPEN (E-20)');
    }
  } else {
    ctx.log.error({ err: error, attempt_id: plan.attemptId }, 'placeCall failed');
  }

  await releaseConcurrency(ctx.redis, tenantId, plan.engine);
  await withTenant(ctx.app, tenantId, async (tx) => {
    await tx
      .update(schema.callAttempts)
      .set({
        status: 'FAILED',
        endReason: code.toLowerCase(),
        endedAt: now,
        lastEventAt: now,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      })
      .where(eq(schema.callAttempts.id, plan.attemptId));
    // The customer was never disturbed: this attempt does not count against them.
    const reschedule = retryAt <= plan.notAfter;
    await tx
      .update(schema.callIntents)
      .set(
        reschedule
          ? {
              status: 'SCHEDULED',
              nextAttemptAt: retryAt,
              attemptsCount: sql`${schema.callIntents.attemptsCount} - 1`,
            }
          : {
              status: 'EXPIRED',
              nextAttemptAt: null,
              completedAt: now,
              gatedReason: 'intent:expired',
            },
      )
      .where(
        and(eq(schema.callIntents.id, intentId), eq(schema.callIntents.status, 'IN_PROGRESS')),
      );
    await audit(tx, {
      tenantId,
      actorType: 'worker',
      actorId: ctx.workerId,
      action: 'attempt.engine_error',
      targetType: 'call_attempt',
      targetId: plan.attemptId,
      after: { code, retry_at: reschedule ? retryAt.toISOString() : null },
    });
  });
  return { kind: 'engine_error', attemptId: plan.attemptId, code };
}
