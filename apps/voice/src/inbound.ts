import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { schema, withTenant, type Db, type Tx } from '@naaradh/db';
import {
  CALLER_ID_ORDER_LOOKBACK_DAYS,
  KEYS,
  admitInbound,
  transferPolicy,
  type AdmissionDeps,
  type ConcurrencyLease,
  type Fallback,
} from '@naaradh/compliance';
import type { InboundCallRequest, InboundDecision } from '@naaradh/engines-core';
import { isVendor } from '@naaradh/engines-registry';
import {
  audit,
  countOrdersForCaller,
  emitMerchantEvent,
  inboundMinutesUsed,
  upsertContact,
} from '@naaradh/pipeline';
import {
  DEFAULT_ABUSE_MESSAGES,
  greetingDiscloses,
  renderInboundPrompt,
  toolDefinitions,
} from '@naaradh/scripts';
import {
  SignatureInvalidError,
  addDays,
  engineWebhookPath,
  hashPhone,
  newId,
  voiceToolPath,
  type PhoneRegion,
} from '@naaradh/shared';
import type { VoiceDeps } from './context.js';
import { headersOf, isUniqueViolation } from './http.js';
import {
  closedMessage,
  enabledTools,
  fallbackForward,
  hoursText,
  loadProfile,
  loadTransferTarget,
  profileHours,
  profileLocale,
  targetHours,
  type ProfileRow,
} from './profiles.js';

/**
 * POST /inbound/:vendor — a customer dialled one of our numbers and the engine asks who
 * answers (AGENTS §5.7). Always returns something the engine can execute: an answer, a
 * forward to the merchant, or a spoken closed message. Never an error the caller would hear
 * as dead air (E-92) — except a bad signature, which is not a caller at all.
 *
 * The tenant comes ONLY from the called number (invariant 16). Budget: < 500 ms p95.
 */
export function registerInboundRoutes(app: FastifyInstance, deps: VoiceDeps): void {
  app.post<{ Params: { vendor: string } }>('/inbound/:vendor', async (request, reply) => {
    const { vendor } = request.params;
    if (!isVendor(vendor)) return reply.code(404).send({ error: 'not found' });
    const adapter = deps.registry.get(vendor);

    let req: InboundCallRequest;
    try {
      req = adapter.parseInboundRequest(headersOf(request.headers), request.body as Buffer);
    } catch (error) {
      if (error instanceof SignatureInvalidError) {
        request.log.warn({ vendor }, 'inbound context rejected: bad signature');
        return reply.code(401).send({ error: 'invalid signature' });
      }
      request.log.warn({ err: error, vendor }, 'inbound context unparseable');
      return reply.code(400).send({ error: 'unparseable' });
    }

    const started = Date.now();
    const decision = await decide(deps, vendor, req, request.log);
    const res = adapter.formatInboundResponse(decision);
    request.log.info(
      {
        vendor,
        decision: decision.kind,
        attempt_id: decision.kind === 'answer' ? decision.attemptId : undefined,
        ms: Date.now() - started,
      },
      'inbound decision',
    );
    return reply.code(res.status).headers(res.headers).send(res.body);
  });
}

const E164 = /^\+[1-9]\d{7,14}$/;

interface Caller {
  readonly e164: string | null;
  readonly hash: string | null;
  /** Withheld, or a caller ID that is not a usable number — both are unverified (E-80). */
  readonly withheld: boolean;
}

function callerOf(req: InboundCallRequest, hashKey: string): Caller {
  if (req.callerE164 === null || !E164.test(req.callerE164))
    return { e164: null, hash: null, withheld: true };
  return { e164: req.callerE164, hash: hashPhone(req.callerE164, hashKey), withheld: false };
}

interface ResolvedNumber {
  readonly numberId: string;
  readonly tenantId: string | null;
  readonly inboundProfileId: string | null;
  readonly engine: string;
  readonly status: 'warming' | 'active' | 'retired' | 'suspended';
  readonly inboundEnabled: boolean;
}

/** SECURITY DEFINER lookup: the one query that runs before a tenant context exists. */
async function resolveNumber(db: Db, e164: string): Promise<ResolvedNumber | null> {
  if (!E164.test(e164)) return null;
  const result = await db.execute<{
    number_id: string;
    tenant_id: string | null;
    inbound_profile_id: string | null;
    engine: string;
    number_status: ResolvedNumber['status'];
    inbound_enabled: boolean;
  }>(sql`select * from resolve_inbound_number(${e164})`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    numberId: row.number_id,
    tenantId: row.tenant_id,
    inboundProfileId: row.inbound_profile_id,
    engine: row.engine,
    status: row.number_status,
    inboundEnabled: row.inbound_enabled,
  };
}

/**
 * E-88 — calls from one caller to one tenant in the last hour, THIS call included. A sorted
 * set keyed by vendor call id, so the engine retrying the context webhook (E-89) is not a
 * second call. Redis down → 0: a customer is never refused because a counter is unavailable.
 */
async function callerCallsLastHour(
  redis: Redis,
  tenantId: string,
  callerHash: string,
  vendorCallId: string,
  now: Date,
): Promise<number> {
  const key = `inbound_calls:${tenantId}:${callerHash}`;
  const t = now.getTime();
  try {
    const results = await redis
      .multi()
      .zadd(key, t, vendorCallId)
      .zremrangebyscore(key, '-inf', t - 3_600_000)
      .zcard(key)
      .expire(key, 3_600)
      .exec();
    const card = results?.[2]?.[1];
    return typeof card === 'number' ? card : 0;
  } catch {
    return 0;
  }
}

async function decide(
  deps: VoiceDeps,
  vendor: string,
  req: InboundCallRequest,
  log: FastifyBaseLogger,
): Promise<InboundDecision> {
  const now = deps.clock.now();
  const caller = callerOf(req, deps.keys.hashKey);

  let resolved: ResolvedNumber | null;
  try {
    resolved = await resolveNumber(deps.db, req.calledE164);
  } catch (error) {
    log.error({ err: error, vendor }, 'inbound: number lookup failed');
    return { kind: 'closed', message: closedMessage(null, null), locale: 'en-IN' };
  }
  // E-81: a number we do not route — or one that belongs to a different engine than the one asking.
  if (resolved === null || resolved.tenantId === null || resolved.engine !== vendor) {
    return { kind: 'closed', message: closedMessage(null, null), locale: 'en-IN' };
  }
  const tenantId = resolved.tenantId;
  const number = resolved;

  // Held across the transaction so a failure after admission gives the slot back.
  let lease: ConcurrencyLease | null = null;
  let profile: ProfileRow | null = null;
  let brand: string | null = null;

  const run = (): Promise<InboundDecision> =>
    withTenant(deps.db, tenantId, async (tx) => {
      const [tenant] = await tx
        .select({
          id: schema.tenants.id,
          name: schema.tenants.name,
          status: schema.tenants.status,
          billingStatus: schema.tenants.billingStatus,
          billingGraceUntil: schema.tenants.billingGraceUntil,
          country: schema.tenants.country,
        })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenantId))
        .limit(1);
      brand = tenant?.name ?? null;
      profile =
        number.inboundProfileId === null ? null : await loadProfile(tx, number.inboundProfileId);

      // E-89: the engine retried the context webhook — same attempt, same answer, no second slot.
      const existing = await findInboundAttempt(tx, vendor, req.vendorCallId);
      if (existing !== null) {
        const p =
          existing.inboundProfileId === null
            ? null
            : await loadProfile(tx, existing.inboundProfileId);
        if (p === null) return fallbackDecision('closed', profile, brand, deps);
        const recognised =
          caller.hash === null
            ? 0
            : await countOrdersForCaller(
                tx,
                tenantId,
                caller.hash,
                addDays(now, -CALLER_ID_ORDER_LOOKBACK_DAYS),
              );
        return buildAnswer(
          tx,
          deps,
          vendor,
          tenantId,
          existing.id,
          p,
          brand ?? '',
          { withheld: caller.withheld, recognisedOrders: recognised },
          now,
        );
      }

      const admissionDeps: AdmissionDeps = {
        killSwitches: deps.killSwitches,
        concurrency: deps.concurrency,
        minutesUsedThisMonth: (t) => inboundMinutesUsed(tx, t, now),
        callerCallsLastHour: (t, h, at) =>
          callerCallsLastHour(deps.redis, t, h, req.vendorCallId, at),
        isEngineCircuitOpen: async (engine) => {
          try {
            return (await deps.redis.get(KEYS.circuit(engine))) === 'open';
          } catch {
            return true; // no Redis → forward to the merchant rather than risk a dead agent
          }
        },
        engineMaxConcurrency: () => deps.engineMaxConcurrency,
      };
      const p: ProfileRow | null = profile;
      const result = await admitInbound(
        {
          now,
          number: {
            id: number.numberId,
            tenantId,
            inboundProfileId: number.inboundProfileId,
            engine: number.engine,
            status: number.status,
            inboundEnabled: number.inboundEnabled,
          },
          tenant:
            tenant === undefined
              ? null
              : {
                  id: tenant.id,
                  status: tenant.status,
                  billingStatus: tenant.billingStatus,
                  billingGraceUntil: tenant.billingGraceUntil,
                },
          profile:
            p === null
              ? null
              : {
                  id: p.id,
                  status: p.status,
                  maxConcurrent: p.maxConcurrent,
                  maxCallsPerCallerHour: p.maxCallsPerCallerHour,
                  monthlyMinuteCap: p.monthlyMinuteCap,
                  hasFallbackForward: p.fallbackForwardEnc !== null,
                },
          callerHash: caller.hash,
        },
        admissionDeps,
      );

      if (!result.ok) {
        await audit(tx, {
          tenantId,
          actorType: 'engine',
          actorId: vendor,
          action: 'inbound.refused',
          targetType: 'number',
          targetId: number.numberId,
          after: {
            reason: result.reason,
            fallback: result.fallback,
            caller_hash: caller.hash,
            vendor_call_id: req.vendorCallId,
            trace: result.trace,
          },
        });
        await emitMerchantEvent(tx, tenantId, {
          type: 'inbound.call_refused',
          eventId: `${vendor}:${req.vendorCallId}:refused`,
          at: now,
          data: { number_id: number.numberId, reason: result.reason, fallback: result.fallback },
        });
        return fallbackDecision(result.fallback, p, brand, deps);
      }
      lease = result.lease;
      if (p === null) throw new Error('admitted without a profile'); // admitInbound step 1 makes this unreachable

      // Invariant 7 at call time: a greeting that lost its disclosure is never spoken by the AI.
      const probe = renderInboundPrompt({
        brand: brand ?? '',
        locale: profileLocale(p),
        greeting: p.greeting,
        persona: null,
        pinnedFacts: [],
        hoursText: '',
        toolsEnabled: [],
        transferAvailableNow: false,
        caller: { withheld: true, recognisedOrders: 0 },
      });
      if (!greetingDiscloses(profileLocale(p), probe.firstUtterance)) {
        await audit(tx, {
          tenantId,
          actorType: 'system',
          action: 'compliance.disclosure_missing',
          targetType: 'inbound_profile',
          targetId: p.id,
          after: { version: p.version },
        });
        log.error(
          { tenant_id: tenantId, profile_id: p.id },
          'inbound greeting lacks disclosure — refusing to answer (invariant 7)',
        );
        await result.lease.release();
        lease = null;
        return fallbackDecision('forward', p, brand, deps);
      }

      let contactId: string | null = null;
      if (caller.e164 !== null) {
        const contact = await upsertContact(tx, deps.keys, {
          tenantId,
          rawPhone: caller.e164,
          defaultRegion: (tenant?.country ?? 'IN') as PhoneRegion,
          source: 'inbound_call',
          at: now,
        });
        // Landlines and other non-dialable callers still get a hash (abuse limit, order match), just no contact.
        if (contact.ok) contactId = contact.contactId;
      }
      const recognised =
        caller.hash === null
          ? 0
          : await countOrdersForCaller(
              tx,
              tenantId,
              caller.hash,
              addDays(now, -CALLER_ID_ORDER_LOOKBACK_DAYS),
            );

      const attemptId = newId('attempt');
      await tx.insert(schema.callAttempts).values({
        id: attemptId,
        tenantId,
        intentId: null,
        contactId,
        phoneHash: caller.hash,
        direction: 'inbound',
        purpose: 'service',
        attemptNo: 1,
        engine: vendor,
        engineCallId: req.vendorCallId,
        fromE164: req.calledE164,
        numberId: number.numberId,
        amdMode: 'continue',
        maxDurationSec: p.maxDurationSec,
        idempotencyKey: `inbound:${vendor}:${req.vendorCallId}`,
        status: 'RINGING',
        startedAt: req.at,
        lastEventAt: now,
        inboundProfileId: p.id,
        profileVersion: p.version,
        callerWithheld: caller.withheld,
        callerVerification: recognised > 0 ? 'caller_id' : 'none',
        callerVerifiedAt: recognised > 0 ? now : null,
        admissionTrace: result.trace,
      });
      await audit(tx, {
        tenantId,
        actorType: 'engine',
        actorId: vendor,
        action: 'inbound.answered',
        targetType: 'call_attempt',
        targetId: attemptId,
        after: {
          profile_id: p.id,
          profile_version: p.version,
          identity: recognised > 0 ? 'caller_id' : 'none',
          withheld: caller.withheld,
        },
      });
      await emitMerchantEvent(tx, tenantId, {
        type: 'call.started',
        eventId: `${attemptId}:started`,
        at: now,
        data: {
          attempt_id: attemptId,
          direction: 'inbound',
          number_id: number.numberId,
          intent_id: null,
        },
      });
      return buildAnswer(
        tx,
        deps,
        vendor,
        tenantId,
        attemptId,
        p,
        brand ?? '',
        { withheld: caller.withheld, recognisedOrders: recognised },
        now,
      );
    });

  try {
    return await run();
  } catch (error) {
    const held = lease as ConcurrencyLease | null;
    if (held !== null) await held.release().catch(() => undefined);
    lease = null;
    // Two deliveries of the same context webhook raced past the lookup: the loser answers from the winner's attempt.
    if (isUniqueViolation(error)) {
      try {
        return await run();
      } catch (retryError) {
        log.error(
          { err: retryError, tenant_id: tenantId },
          'inbound: retry after duplicate failed',
        );
      }
    } else {
      log.error({ err: error, tenant_id: tenantId }, 'inbound: decision failed, falling back');
    }
    return fallbackDecision('forward', profile, brand, deps);
  }
}

async function findInboundAttempt(tx: Tx, vendor: string, vendorCallId: string) {
  const [row] = await tx
    .select({ id: schema.callAttempts.id, inboundProfileId: schema.callAttempts.inboundProfileId })
    .from(schema.callAttempts)
    .where(
      and(
        eq(schema.callAttempts.engine, vendor),
        eq(schema.callAttempts.engineCallId, vendorCallId),
        eq(schema.callAttempts.direction, 'inbound'),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function buildAnswer(
  tx: Tx,
  deps: VoiceDeps,
  vendor: string,
  tenantId: string,
  attemptId: string,
  profile: ProfileRow,
  brand: string,
  caller: { withheld: boolean; recognisedOrders: number },
  now: Date,
): Promise<InboundDecision> {
  const locale = profileLocale(profile);
  const tools = enabledTools(profile);
  const hours = profileHours(profile);
  const target = await loadTransferTarget(tx, profile.transferTargetId);
  const transferNow =
    tools.includes('transfer_to_human') &&
    target !== null &&
    hours !== null &&
    transferPolicy(
      {
        id: target.id,
        active: target.active,
        verifiedAt: target.verifiedAt,
        hours: targetHours(target),
      },
      hours,
      now,
    ).transfer;
  const rendered = renderInboundPrompt({
    brand,
    locale,
    greeting: profile.greeting,
    persona: profile.persona,
    pinnedFacts: profile.pinnedFacts,
    hoursText: hoursText(profile),
    toolsEnabled: tools,
    transferAvailableNow: transferNow,
    caller,
  });
  return {
    kind: 'answer',
    attemptId,
    firstUtterance: rendered.firstUtterance,
    systemPrompt: rendered.systemPrompt,
    variables: rendered.variables,
    tools: toolDefinitions({
      tools,
      locale,
      urlFor: (t) =>
        `${deps.voiceBaseUrl}${voiceToolPath(deps.engineWebhookKey, vendor, tenantId, t)}`,
    }),
    maxDurationSec: profile.maxDurationSec,
    locale,
    voiceId: profile.voiceId,
    webhookUrl: `${deps.hooksBaseUrl}${engineWebhookPath(deps.engineWebhookKey, vendor, tenantId)}`,
  };
}

/** E-92: forward to the merchant's own line when there is one; otherwise speak, then hang up. */
function fallbackDecision(
  kind: Fallback,
  profile: ProfileRow | null,
  brand: string | null,
  deps: VoiceDeps,
): InboundDecision {
  const locale = profileLocale(profile);
  if (kind === 'forward') {
    const to = fallbackForward(profile, deps.keys.staffPrivateKeyPem);
    if (to !== null) return { kind: 'forward', toE164: to, announcement: null };
  }
  if (kind === 'abuse')
    return {
      kind: 'closed',
      message: DEFAULT_ABUSE_MESSAGES[locale === 'hi-IN' ? 'hi-IN' : 'en-IN'],
      locale,
    };
  return { kind: 'closed', message: closedMessage(profile, brand), locale };
}
