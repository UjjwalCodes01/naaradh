import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withTenant, type Db } from '@naaradh/db';
import { DNC_REQUESTS_PER_IP_PER_HOUR, ERASURE_COMPLETION_TARGET_DAYS } from '@naaradh/compliance';
import { DNC_CONFIRMATION, audit, submitDncRequest, type PhoneKeys } from '@naaradh/pipeline';
import {
  NaaradhError,
  addDays,
  hashPhone,
  newId,
  normalizePhone,
  type PhoneRegion,
} from '@naaradh/shared';
import { requireScope } from '../auth.js';

/**
 * Privacy + complaints (P2-CMP-1…3):
 *
 *   POST /v1/public/dnc               the /do-not-call page — no key, rate-limited, global suppression
 *   POST /v1/complaints               a merchant files a customer's complaint     complaints:write
 *   GET  /v1/complaints               complaints and pending reports              complaints:read
 *   POST /v1/erasure-requests         a merchant forwards a verified erasure      privacy:write
 *   GET  /v1/erasure-requests/:id                                                 privacy:read
 *
 * The public page can suppress and report — both protective — but never erase: erasure is
 * destructive and needs the person's identity verified, which the merchant (the data
 * fiduciary) or Naaradh staff do before filing it.
 */
export interface PrivacyRouteDeps {
  readonly db: Db;
  readonly redis: Redis;
  readonly keys: PhoneKeys;
  readonly clock: () => Date;
}

const Phone = z.object({
  phone: z.string().min(5).max(32),
  phone_region: z.string().length(2).default('IN'),
});

const DncBody = Phone.extend({ report_unwanted_call: z.boolean().default(false) }).strict();

const ComplaintBody = Phone.extend({
  external_ref: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
}).strict();

const ErasureBody = Phone.extend({ external_ref: z.string().max(200).optional() }).strict();

function phoneHashOf(keys: PhoneKeys, body: z.infer<typeof Phone>): string {
  const parsed = normalizePhone(body.phone, body.phone_region.toUpperCase() as PhoneRegion);
  if (!parsed.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'phone is not a valid number', {
      context: { reason: parsed.reason },
    });
  return hashPhone(parsed.phone.e164, keys.hashKey);
}

export function registerPrivacyRoutes(app: FastifyInstance, deps: PrivacyRouteDeps): void {
  app.post(
    '/v1/public/dnc',
    {
      config: {
        public: true,
        rateLimit: { max: DNC_REQUESTS_PER_IP_PER_HOUR, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const body = DncBody.parse(request.body);
      await submitDncRequest(deps.db, deps.redis, {
        hashKey: deps.keys.hashKey,
        phone: body.phone,
        region: body.phone_region,
        reportUnwantedCall: body.report_unwanted_call,
        ip: request.ip,
        now: deps.clock(),
      });
      // Identical response whether or not the number was ever called — no oracle.
      return reply.code(202).send({ status: 'received', message: DNC_CONFIRMATION });
    },
  );

  app.post('/v1/complaints', async (request, reply) => {
    const auth = requireScope(request, 'complaints:write');
    const body = ComplaintBody.parse(request.body);
    const phoneHash = phoneHashOf(deps.keys, body);
    const id = newId('complaintReport');
    await withTenant(deps.db, auth.tenantId, async (tx) => {
      await tx.insert(schema.complaintReports).values({
        id,
        tenantId: auth.tenantId,
        phoneHash,
        source: 'merchant',
        reporter: `api_key:${auth.apiKeyId}`,
        externalRef: body.external_ref ?? null,
        notes: body.notes ?? null,
        reportedAt: deps.clock(),
      });
      await audit(tx, {
        tenantId: auth.tenantId,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'complaint.reported',
        targetType: 'complaint_report',
        targetId: id,
      });
    });
    return reply.code(202).send({ report_id: id, status: 'pending' });
  });

  app.get('/v1/complaints', async (request) => {
    const auth = requireScope(request, 'complaints:read');
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const complaints = await tx
        .select({
          id: schema.complaints.id,
          source: schema.complaints.source,
          status: schema.complaints.status,
          attempt_id: schema.complaints.attemptId,
          external_ref: schema.complaints.externalRef,
          received_at: schema.complaints.receivedAt,
        })
        .from(schema.complaints)
        .where(eq(schema.complaints.tenantId, auth.tenantId))
        .orderBy(desc(schema.complaints.receivedAt))
        .limit(200);
      const pending = await tx
        .select({ id: schema.complaintReports.id, reported_at: schema.complaintReports.reportedAt })
        .from(schema.complaintReports)
        .where(
          and(
            eq(schema.complaintReports.tenantId, auth.tenantId),
            eq(schema.complaintReports.status, 'pending'),
          ),
        );
      return { data: complaints, pending_reports: pending };
    });
  });

  app.post('/v1/erasure-requests', async (request, reply) => {
    const auth = requireScope(request, 'privacy:write');
    const body = ErasureBody.parse(request.body);
    const phoneHash = phoneHashOf(deps.keys, body);
    const now = deps.clock();
    const id = newId('erasure');
    await withTenant(deps.db, auth.tenantId, async (tx) => {
      await tx.insert(schema.erasureRequests).values({
        id,
        tenantId: auth.tenantId,
        phoneHash,
        source: 'api',
        externalRef: body.external_ref ?? null,
        requestedAt: now,
        dueAt: addDays(now, ERASURE_COMPLETION_TARGET_DAYS),
      });
      await audit(tx, {
        tenantId: auth.tenantId,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'erasure.requested',
        targetType: 'erasure_request',
        targetId: id,
      });
    });
    return reply.code(202).send({
      id,
      status: 'requested',
      due_at: addDays(now, ERASURE_COMPLETION_TARGET_DAYS).toISOString(),
    });
  });

  app.get<{ Params: { id: string } }>('/v1/erasure-requests/:id', async (request) => {
    const auth = requireScope(request, 'privacy:read');
    const [row] = await withTenant(deps.db, auth.tenantId, (tx) =>
      tx
        .select({
          id: schema.erasureRequests.id,
          status: schema.erasureRequests.status,
          requested_at: schema.erasureRequests.requestedAt,
          due_at: schema.erasureRequests.dueAt,
          completed_at: schema.erasureRequests.completedAt,
          report: schema.erasureRequests.report,
        })
        .from(schema.erasureRequests)
        .where(
          and(
            eq(schema.erasureRequests.tenantId, auth.tenantId),
            eq(schema.erasureRequests.id, request.params.id),
          ),
        )
        .limit(1),
    );
    if (row === undefined) throw new NaaradhError('NOT_FOUND', 'erasure request not found');
    return row;
  });
}
