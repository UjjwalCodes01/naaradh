import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Tx } from '@naaradh/db';
import { BusinessHours } from '@naaradh/compliance';
import { sanitiseMerchantText, validateInboundProfile } from '@naaradh/scripts';
import {
  NaaradhError,
  encryptPhone,
  hashPhone,
  maskPhone,
  newId,
  normalizePhone,
  type PhoneRegion,
} from '@naaradh/shared';
import { audit } from '../audit.js';
import { emitMerchantEvent } from '../outbox.js';
import { actorLabel, auditActor, type Actor } from './actor.js';

/**
 * The support line's configuration (ADR-0006) as domain operations shared by the public API
 * (apps/api) and the dashboards (apps/web, apps/shopify): inbound profiles, knowledge
 * articles, transfer targets, tickets. Every function runs inside the caller's withTenant()
 * transaction and writes its own audit row.
 *
 * Staff numbers (transfer targets, fallback line) are encrypted with the STAFF public key: a
 * surface can store them and never read them back (invariant 19).
 */

export interface StaffKeys {
  readonly hashKey: string;
  readonly publicKeyPem: string;
  readonly kid: number;
}

export const StaffPhoneInput = z.object({
  phone: z.string().min(5).max(32),
  phone_region: z.string().length(2).default('IN'),
});

export const ProfileInput = z.object({
  name: z.string().trim().min(1).max(80),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  greeting: z.string(),
  persona: z.string().nullable().default(null),
  pinned_facts: z.array(z.string()).default([]),
  tools_enabled: z.array(z.string()).min(1),
  closed_message: z.string(),
  business_hours: BusinessHours,
  fallback_forward: StaffPhoneInput.nullable().default(null),
  transfer_target_id: z.string().nullable().default(null),
  max_duration_sec: z.number().int().min(60).max(1800).default(600),
  max_concurrent: z.number().int().min(1).max(100).default(2),
  max_calls_per_caller_hour: z.number().int().min(1).max(60).default(6),
  monthly_minute_cap: z.number().int().min(1).nullable().default(null),
  /** Invariant 14 as amended by ADR-0006 — off unless the merchant turns it on. */
  agent_cancel_enabled: z.boolean().default(false),
  voice_id: z.string().max(100).nullable().default(null),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

export const KnowledgeInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  locale: z
    .string()
    .regex(/^[a-z]{2}-[A-Z]{2}$/)
    .default('en-IN'),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
});
export type KnowledgeInput = z.infer<typeof KnowledgeInput>;

export const TransferTargetInput = StaffPhoneInput.extend({
  label: z.string().trim().min(1).max(80),
  hours: BusinessHours.nullable().default(null),
});
export type TransferTargetInput = z.infer<typeof TransferTargetInput>;

export const ATTESTATION_STATEMENT =
  'I confirm this number belongs to our staff and may receive customer calls.';

export const AttestationInput = z.object({
  attested_by: z.string().trim().min(2).max(120),
  role: z.enum(['owner', 'manager']),
  statement: z.literal(ATTESTATION_STATEMENT),
});
export type AttestationInput = z.infer<typeof AttestationInput>;

/** Error context is flat (NaaradhError): `code@path; …`, which is what a client needs to fix it. */
export function describeErrors(errors: readonly { code: string; path?: string }[]): string {
  return errors.map((e) => (e.path === undefined ? e.code : `${e.code}@${e.path}`)).join('; ');
}

function encryptStaff(keys: StaffKeys, phone: z.infer<typeof StaffPhoneInput>) {
  const parsed = normalizePhone(phone.phone, phone.phone_region.toUpperCase() as PhoneRegion);
  if (!parsed.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'phone is not a valid number', {
      context: { reason: parsed.reason },
    });
  const enc = encryptPhone(parsed.phone.e164, keys.publicKeyPem, keys.kid);
  return {
    hash: hashPhone(parsed.phone.e164, keys.hashKey),
    enc,
    masked: maskPhone(parsed.phone.e164),
    region: parsed.phone.region,
  };
}

/** Greeting disclosure, known tools, fact limits — the same validator the voice runtime trusts. */
function validateProfile(body: ProfileInput) {
  const v = validateInboundProfile({
    locale: body.locale,
    greeting: body.greeting,
    persona: body.persona,
    pinnedFacts: body.pinned_facts,
    toolsEnabled: body.tools_enabled,
    closedMessage: body.closed_message,
  });
  if (!v.ok)
    throw new NaaradhError('VALIDATION_FAILED', 'inbound profile is invalid', {
      context: { errors: describeErrors(v.errors) },
    });
  return v.profile;
}

async function assertTargetOfTenant(tx: Tx, tenantId: string, id: string | null): Promise<void> {
  if (id === null) return;
  const [t] = await tx
    .select({ id: schema.transferTargets.id })
    .from(schema.transferTargets)
    .where(and(eq(schema.transferTargets.tenantId, tenantId), eq(schema.transferTargets.id, id)))
    .limit(1);
  if (t === undefined)
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'transfer_target_id is not one of your transfer targets',
    );
}

type ProfileRow = typeof schema.inboundProfiles.$inferSelect;

export function profileView(p: ProfileRow) {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    status: p.status,
    locale: p.locale,
    greeting: p.greeting,
    persona: p.persona,
    pinned_facts: p.pinnedFacts,
    tools_enabled: p.toolsEnabled,
    closed_message: p.closedMessage,
    business_hours: p.businessHours,
    fallback_forward: p.fallbackForwardMasked,
    transfer_target_id: p.transferTargetId,
    max_duration_sec: p.maxDurationSec,
    max_concurrent: p.maxConcurrent,
    max_calls_per_caller_hour: p.maxCallsPerCallerHour,
    monthly_minute_cap: p.monthlyMinuteCap,
    agent_cancel_enabled: p.agentCancelEnabled,
    voice_id: p.voiceId,
    updated_at: p.updatedAt.toISOString(),
  };
}
export type ProfileView = ReturnType<typeof profileView>;

// ---- inbound profiles ---------------------------------------------------------------------------

export async function listProfiles(tx: Tx, tenantId: string): Promise<ProfileView[]> {
  const rows = await tx
    .select()
    .from(schema.inboundProfiles)
    .where(eq(schema.inboundProfiles.tenantId, tenantId))
    .orderBy(desc(schema.inboundProfiles.updatedAt));
  return rows.map(profileView);
}

export async function getProfile(tx: Tx, tenantId: string, id: string): Promise<ProfileView> {
  const [row] = await tx
    .select()
    .from(schema.inboundProfiles)
    .where(and(eq(schema.inboundProfiles.tenantId, tenantId), eq(schema.inboundProfiles.id, id)))
    .limit(1);
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'inbound profile not found');
  return profileView(row);
}

function profileColumns(body: ProfileInput, keys: StaffKeys) {
  const valid = validateProfile(body);
  const fallback =
    body.fallback_forward === null ? null : encryptStaff(keys, body.fallback_forward);
  return {
    valid,
    fallback,
    columns: {
      name: body.name,
      locale: valid.locale,
      greeting: valid.greeting,
      persona: valid.persona === null ? null : sanitiseMerchantText(valid.persona, 300),
      businessHours: body.business_hours,
      toolsEnabled: valid.toolsEnabled,
      pinnedFacts: valid.pinnedFacts.map((f) => sanitiseMerchantText(f, 200)),
      closedMessage: sanitiseMerchantText(valid.closedMessage, 400),
      fallbackForwardEnc: fallback?.enc.ciphertext ?? null,
      fallbackForwardKid: fallback?.enc.kid ?? null,
      fallbackForwardMasked: fallback?.masked ?? null,
      transferTargetId: body.transfer_target_id,
      maxDurationSec: body.max_duration_sec,
      maxConcurrent: body.max_concurrent,
      maxCallsPerCallerHour: body.max_calls_per_caller_hour,
      monthlyMinuteCap: body.monthly_minute_cap,
      agentCancelEnabled: body.agent_cancel_enabled,
      voiceId: body.voice_id,
    },
  };
}

export async function createProfile(
  tx: Tx,
  actor: Actor,
  keys: StaffKeys,
  input: ProfileInput,
): Promise<{ id: string; status: 'draft'; version: 1 }> {
  const { valid, fallback, columns } = profileColumns(input, keys);
  await assertTargetOfTenant(tx, actor.tenantId, input.transfer_target_id);
  const id = newId('inboundProfile');
  await tx
    .insert(schema.inboundProfiles)
    .values({ id, tenantId: actor.tenantId, status: 'draft', ...columns });
  await audit(tx, {
    ...auditActor(actor),
    action: 'inbound_profile.created',
    targetType: 'inbound_profile',
    targetId: id,
    after: {
      tools: valid.toolsEnabled,
      agent_cancel_enabled: input.agent_cancel_enabled,
      fallback: fallback?.masked ?? null,
    },
  });
  return { id, status: 'draft', version: 1 };
}

/**
 * Full replacement of the configuration; the version trigger stamps a new version. A null
 * `fallback_forward` keeps the stored number when `keepFallback` is set (dashboards cannot
 * show the number back, so "unchanged" must be expressible).
 */
export async function updateProfile(
  tx: Tx,
  actor: Actor,
  keys: StaffKeys,
  id: string,
  input: ProfileInput,
  options: { readonly keepFallback?: boolean } = {},
): Promise<ProfileView> {
  const { columns } = profileColumns(input, keys);
  await assertTargetOfTenant(tx, actor.tenantId, input.transfer_target_id);
  const keep = options.keepFallback === true && input.fallback_forward === null;
  const {
    fallbackForwardEnc: _e,
    fallbackForwardKid: _k,
    fallbackForwardMasked: _m,
    ...rest
  } = columns;
  const [row] = await tx
    .update(schema.inboundProfiles)
    .set(keep ? rest : columns)
    .where(
      and(eq(schema.inboundProfiles.tenantId, actor.tenantId), eq(schema.inboundProfiles.id, id)),
    )
    .returning();
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'inbound profile not found');
  await audit(tx, {
    ...auditActor(actor),
    action: 'inbound_profile.updated',
    targetType: 'inbound_profile',
    targetId: row.id,
    after: {
      version: row.version,
      tools: row.toolsEnabled,
      agent_cancel_enabled: row.agentCancelEnabled,
    },
  });
  return profileView(row);
}

export async function setProfileStatus(
  tx: Tx,
  actor: Actor,
  id: string,
  status: 'active' | 'disabled',
): Promise<{ id: string; status: 'active' | 'disabled' }> {
  const [existing] = await tx
    .select()
    .from(schema.inboundProfiles)
    .where(
      and(eq(schema.inboundProfiles.tenantId, actor.tenantId), eq(schema.inboundProfiles.id, id)),
    )
    .limit(1);
  if (existing === undefined) throw new NaaradhError('NOT_FOUND', 'inbound profile not found');
  if (status === 'active') {
    // Re-validated at activation: a profile goes live only with its disclosure intact (invariant 7).
    const v = validateInboundProfile({
      locale: existing.locale,
      greeting: existing.greeting,
      persona: existing.persona,
      pinnedFacts: existing.pinnedFacts,
      toolsEnabled: existing.toolsEnabled,
      closedMessage: existing.closedMessage,
    });
    if (!v.ok)
      throw new NaaradhError('VALIDATION_FAILED', 'inbound profile is invalid', {
        context: { errors: describeErrors(v.errors) },
      });
  }
  await tx
    .update(schema.inboundProfiles)
    .set({ status })
    .where(eq(schema.inboundProfiles.id, existing.id));
  await audit(tx, {
    ...auditActor(actor),
    action: `inbound_profile.${status}`,
    targetType: 'inbound_profile',
    targetId: existing.id,
    before: { status: existing.status },
    after: { status },
  });
  return { id: existing.id, status };
}

// ---- knowledge ------------------------------------------------------------------------------------

export interface ArticleView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly locale: string;
  readonly tags: string[];
  readonly status: 'draft' | 'published' | 'archived';
  readonly updated_at: string;
}

export async function listArticles(tx: Tx, tenantId: string): Promise<ArticleView[]> {
  const rows = await tx
    .select({
      id: schema.knowledgeArticles.id,
      title: schema.knowledgeArticles.title,
      body: schema.knowledgeArticles.body,
      locale: schema.knowledgeArticles.locale,
      tags: schema.knowledgeArticles.tags,
      status: schema.knowledgeArticles.status,
      updatedAt: schema.knowledgeArticles.updatedAt,
    })
    .from(schema.knowledgeArticles)
    .where(eq(schema.knowledgeArticles.tenantId, tenantId))
    .orderBy(desc(schema.knowledgeArticles.updatedAt))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    locale: r.locale,
    tags: r.tags,
    status: r.status,
    updated_at: r.updatedAt.toISOString(),
  }));
}

export async function createArticle(
  tx: Tx,
  actor: Actor,
  input: KnowledgeInput,
): Promise<{ id: string; status: KnowledgeInput['status'] }> {
  const id = newId('knowledgeArticle');
  await tx.insert(schema.knowledgeArticles).values({
    id,
    tenantId: actor.tenantId,
    title: sanitiseMerchantText(input.title, 200),
    body: sanitiseMerchantText(input.body, 8000),
    locale: input.locale,
    tags: input.tags,
    status: input.status,
    createdBy: actorLabel(actor),
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'knowledge.created',
    targetType: 'knowledge_article',
    targetId: id,
    after: { status: input.status, locale: input.locale },
  });
  return { id, status: input.status };
}

export async function updateArticle(
  tx: Tx,
  actor: Actor,
  id: string,
  input: KnowledgeInput,
): Promise<{ id: string; status: KnowledgeInput['status'] }> {
  const [row] = await tx
    .update(schema.knowledgeArticles)
    .set({
      title: sanitiseMerchantText(input.title, 200),
      body: sanitiseMerchantText(input.body, 8000),
      locale: input.locale,
      tags: input.tags,
      status: input.status,
    })
    .where(
      and(
        eq(schema.knowledgeArticles.tenantId, actor.tenantId),
        eq(schema.knowledgeArticles.id, id),
      ),
    )
    .returning({ id: schema.knowledgeArticles.id, status: schema.knowledgeArticles.status });
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'article not found');
  await audit(tx, {
    ...auditActor(actor),
    action: 'knowledge.updated',
    targetType: 'knowledge_article',
    targetId: row.id,
    after: { status: row.status },
  });
  return row;
}

// ---- transfer targets (invariant 19) ------------------------------------------------------------------

export interface TransferTargetView {
  readonly id: string;
  readonly label: string;
  readonly phone: string;
  readonly verified_at: Date | null;
  readonly active: boolean;
  readonly hours: unknown;
}

export async function listTransferTargets(tx: Tx, tenantId: string): Promise<TransferTargetView[]> {
  return tx
    .select({
      id: schema.transferTargets.id,
      label: schema.transferTargets.label,
      phone: schema.transferTargets.phoneMasked,
      verified_at: schema.transferTargets.verifiedAt,
      active: schema.transferTargets.active,
      hours: schema.transferTargets.hours,
    })
    .from(schema.transferTargets)
    .where(eq(schema.transferTargets.tenantId, tenantId));
}

export async function createTransferTarget(
  tx: Tx,
  actor: Actor,
  keys: StaffKeys,
  input: TransferTargetInput,
): Promise<{ id: string; phone: string; verified: false }> {
  const staff = encryptStaff(keys, input);
  const id = newId('transferTarget');
  await tx.insert(schema.transferTargets).values({
    id,
    tenantId: actor.tenantId,
    label: input.label,
    phoneHash: staff.hash,
    phoneEnc: staff.enc.ciphertext,
    phoneEncKid: staff.enc.kid,
    phoneMasked: staff.masked,
    region: staff.region,
    verifiedAt: null,
    active: true,
    hours: input.hours,
  });
  await audit(tx, {
    ...auditActor(actor),
    action: 'transfer_target.created',
    targetType: 'transfer_target',
    targetId: id,
    after: { label: input.label, phone: staff.masked },
  });
  // Not transferable until verified (E-86): a test call from onboarding, or an attestation.
  return { id, phone: staff.masked, verified: false };
}

export async function verifyTransferTarget(
  tx: Tx,
  actor: Actor,
  id: string,
  input: AttestationInput,
  now: Date,
): Promise<{ id: string; verified_at: string; method: 'attestation' }> {
  const [row] = await tx
    .update(schema.transferTargets)
    .set({ verifiedAt: now })
    .where(
      and(eq(schema.transferTargets.tenantId, actor.tenantId), eq(schema.transferTargets.id, id)),
    )
    .returning({ id: schema.transferTargets.id, phone: schema.transferTargets.phoneMasked });
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'transfer target not found');
  await audit(tx, {
    ...auditActor(actor),
    action: 'transfer_target.verified',
    targetType: 'transfer_target',
    targetId: row.id,
    after: {
      method: 'attestation',
      attested_by: input.attested_by,
      role: input.role,
      phone: row.phone,
    },
  });
  return { id: row.id, verified_at: now.toISOString(), method: 'attestation' };
}

export async function deactivateTransferTarget(
  tx: Tx,
  actor: Actor,
  id: string,
): Promise<{ id: string; active: false }> {
  const [row] = await tx
    .update(schema.transferTargets)
    .set({ active: false })
    .where(
      and(eq(schema.transferTargets.tenantId, actor.tenantId), eq(schema.transferTargets.id, id)),
    )
    .returning({ id: schema.transferTargets.id });
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'transfer target not found');
  await audit(tx, {
    ...auditActor(actor),
    action: 'transfer_target.deactivated',
    targetType: 'transfer_target',
    targetId: row.id,
  });
  return { id: row.id, active: false };
}

// ---- tickets --------------------------------------------------------------------------------------------

export type TicketStatus = 'open' | 'in_progress' | 'resolved';

export async function listTickets(
  tx: Tx,
  tenantId: string,
  filter: { readonly status?: TicketStatus | undefined; readonly limit?: number } = {},
) {
  return tx
    .select({
      id: schema.supportTickets.id,
      category: schema.supportTickets.category,
      summary: schema.supportTickets.summary,
      status: schema.supportTickets.status,
      priority: schema.supportTickets.priority,
      callback_requested: schema.supportTickets.callbackRequested,
      preferred_time: schema.supportTickets.preferredTime,
      order_id: schema.supportTickets.orderId,
      order_name: schema.orders.name,
      attempt_id: schema.supportTickets.attemptId,
      created_at: schema.supportTickets.createdAt,
    })
    .from(schema.supportTickets)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.supportTickets.orderId))
    .where(
      and(
        eq(schema.supportTickets.tenantId, tenantId),
        filter.status === undefined ? sql`true` : eq(schema.supportTickets.status, filter.status),
      ),
    )
    .orderBy(desc(schema.supportTickets.priority), desc(schema.supportTickets.createdAt))
    .limit(Math.min(filter.limit ?? 200, 500));
}

export async function resolveTicket(
  tx: Tx,
  actor: Actor,
  id: string,
  resolution: string,
  now: Date,
): Promise<{ id: string; status: 'resolved'; resolved_at: string }> {
  const text = resolution.trim();
  if (text.length < 2 || text.length > 1000)
    throw new NaaradhError('VALIDATION_FAILED', 'resolution must be 2–1000 characters');
  const [row] = await tx
    .update(schema.supportTickets)
    .set({
      status: 'resolved',
      resolvedAt: now,
      resolvedBy: actorLabel(actor),
      resolution: sanitiseMerchantText(text, 1000),
    })
    .where(
      and(eq(schema.supportTickets.tenantId, actor.tenantId), eq(schema.supportTickets.id, id)),
    )
    .returning({ id: schema.supportTickets.id, category: schema.supportTickets.category });
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'ticket not found');
  await audit(tx, {
    ...auditActor(actor),
    action: 'ticket.resolved',
    targetType: 'support_ticket',
    targetId: row.id,
  });
  await emitMerchantEvent(tx, actor.tenantId, {
    type: 'ticket.resolved',
    eventId: `${row.id}:resolved`,
    at: now,
    data: { ticket_id: row.id, category: row.category },
  });
  return { id: row.id, status: 'resolved', resolved_at: now.toISOString() };
}

/** Someone is working on it. Resolved tickets are final; reopening is a new ticket. */
export async function startTicket(tx: Tx, actor: Actor, id: string): Promise<{ id: string }> {
  const [row] = await tx
    .update(schema.supportTickets)
    .set({ status: 'in_progress' })
    .where(
      and(
        eq(schema.supportTickets.tenantId, actor.tenantId),
        eq(schema.supportTickets.id, id),
        eq(schema.supportTickets.status, 'open'),
      ),
    )
    .returning({ id: schema.supportTickets.id });
  if (row === undefined) throw new NaaradhError('NOT_FOUND', 'no open ticket with that id');
  await audit(tx, {
    ...auditActor(actor),
    action: 'ticket.started',
    targetType: 'support_ticket',
    targetId: row.id,
  });
  return row;
}
