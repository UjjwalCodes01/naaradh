import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, type Db } from '@naaradh/db';
import { audit, exportAuditLog } from '@naaradh/pipeline';
import { requireScope } from '../auth.js';

/**
 * GET /v1/audit-log — the tenant's own audit trail for a SIEM or an auditor (P7-ENT-1), paged
 * oldest-first with an opaque cursor. Scope `audit:read`, which no key gets by default.
 *
 * Reading the log is itself recorded, once per export (the first page), not once per page: a
 * SIEM polling every minute should not fill the log it is reading with its own reads.
 */
export interface AuditRouteDeps {
  readonly db: Db;
}

const Query = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  after: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  app.get('/v1/audit-log', async (request) => {
    const auth = requireScope(request, 'audit:read');
    const q = Query.parse(request.query);
    const range = { from: new Date(q.from), to: new Date(q.to) };
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const page = await exportAuditLog(tx, auth.tenantId, range, {
        ...(q.after === undefined ? {} : { after: q.after }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      });
      if (q.after === undefined)
        await audit(tx, {
          tenantId: auth.tenantId,
          actorType: 'api_key',
          actorId: auth.apiKeyId,
          action: 'audit_log.exported',
          targetType: 'tenant',
          targetId: auth.tenantId,
          after: { from: q.from, to: q.to, via: 'api' },
          requestId: request.id,
        });
      return {
        data: page.rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actor_type: r.actorType,
          actor: r.actor,
          action: r.action,
          target_type: r.targetType,
          target_id: r.targetId,
          request_id: r.requestId,
          before: r.before,
          after: r.after,
        })),
        next: page.next,
      };
    });
  });
}
