import { PROMOTIONAL_USE_CASES } from '@naaradh/compliance';
import { and, desc, eq, ne } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { validateScript } from '@naaradh/scripts';
import { NaaradhError } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';
import { describeErrors } from '../admin/support.js';
import { requireRole, type Role } from './team.js';
import { isAbTestRunning } from './ab.js';
import { requireDltTemplate } from './dlt-template.js';

/**
 * Script review and approval (AGENTS §9, P2-SHOP-2 "script review + approval"). The dispatcher
 * uses only an `approved` version; approval runs the disclosure validator again (invariant 7)
 * and records who approved it. Approving a version retires the previously approved one for the
 * same use case and locale, so exactly one is live.
 */

export interface ScriptView {
  readonly id: string;
  readonly useCase: string;
  readonly locale: string;
  readonly version: number;
  readonly status: string;
  readonly opening: string;
  readonly purposeLine: string;
  readonly closing: string;
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
  readonly problems: string | null;
  readonly abArm: string | null;
  readonly dltTemplateId: string | null;
  readonly promotional: boolean;
}

function field(body: unknown, key: string): string {
  if (body === null || typeof body !== 'object') return '';
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

export async function listScripts(tx: Tx, tenantId: string): Promise<ScriptView[]> {
  const rows = await tx
    .select({
      id: schema.scripts.id,
      useCase: schema.useCases.kind,
      locale: schema.scripts.locale,
      version: schema.scripts.version,
      status: schema.scripts.status,
      body: schema.scripts.body,
      approvedAt: schema.scripts.approvedAt,
      createdAt: schema.scripts.createdAt,
      abArm: schema.scripts.abArm,
      dltTemplateId: schema.scripts.dltTemplateId,
    })
    .from(schema.scripts)
    .innerJoin(schema.useCases, eq(schema.useCases.id, schema.scripts.useCaseId))
    .where(and(eq(schema.scripts.tenantId, tenantId), ne(schema.scripts.status, 'retired')))
    .orderBy(schema.useCases.kind, schema.scripts.locale, desc(schema.scripts.version));
  return rows.map((r) => {
    const v = validateScript(r.body);
    return {
      id: r.id,
      useCase: r.useCase,
      locale: r.locale,
      version: r.version,
      status: r.status,
      opening: field(r.body, 'opening'),
      purposeLine: field(r.body, 'purpose_line'),
      closing: field(r.body, 'closing'),
      approvedAt: r.approvedAt,
      createdAt: r.createdAt,
      problems: v.ok ? null : v.errors.map((e) => e.message).join('; '),
      abArm: r.abArm,
      dltTemplateId: r.dltTemplateId,
      promotional: (PROMOTIONAL_USE_CASES as readonly string[]).includes(r.useCase),
    };
  });
}

export async function approveScript(
  tx: Tx,
  actor: Actor,
  actorRole: Role,
  scriptId: string,
  now: Date,
  options: { readonly dltTemplateId?: string | null } = {},
): Promise<void> {
  requireRole(actorRole, 'manager');
  const [s] = await tx
    .select()
    .from(schema.scripts)
    .where(and(eq(schema.scripts.tenantId, actor.tenantId), eq(schema.scripts.id, scriptId)))
    .for('update')
    .limit(1);
  if (s === undefined) throw new NaaradhError('NOT_FOUND', 'script not found');
  if (s.status !== 'draft')
    throw new NaaradhError('VALIDATION_FAILED', `this version is already ${s.status}`);
  const v = validateScript(s.body);
  if (!v.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'script fails validation', {
      context: { errors: describeErrors(v.errors) },
    });
  // E-116: a running A/B test owns this use case and language until it is ended.
  if (await isAbTestRunning(tx, actor.tenantId, s.useCaseId, s.locale))
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'an A/B test is running for this script and language; end it before approving another version',
    );
  const templateId = await requireDltTemplate(
    tx,
    actor.tenantId,
    s.useCaseId,
    options.dltTemplateId?.trim() || s.dltTemplateId,
  );
  const retired = await tx
    .update(schema.scripts)
    .set({ status: 'retired', retiredAt: now })
    .where(
      and(
        eq(schema.scripts.tenantId, actor.tenantId),
        eq(schema.scripts.useCaseId, s.useCaseId),
        eq(schema.scripts.locale, s.locale),
        eq(schema.scripts.status, 'approved'),
      ),
    )
    .returning({ id: schema.scripts.id });
  await tx
    .update(schema.scripts)
    .set({
      status: 'approved',
      disclosureValidatedAt: now,
      approvedByUserId: actor.id,
      approvedAt: now,
      dltTemplateId: templateId,
    })
    .where(eq(schema.scripts.id, s.id));
  await audit(tx, {
    ...auditActor(actor),
    action: 'script.approved',
    targetType: 'script',
    targetId: s.id,
    after: { version: s.version, locale: s.locale, retired: retired.map((r) => r.id) },
  });
}
