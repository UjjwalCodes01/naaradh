import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withTenant, type Db, type Tx } from '@naaradh/db';
import {
  ABANDONED_CART_EN_IN,
  ABANDONED_CART_HI_IN,
  COD_CONFIRM_EN_IN,
  COD_CONFIRM_HI_IN,
  FEEDBACK_EN_IN,
  FEEDBACK_HI_IN,
  LEAD_CALLBACK_EN_IN,
  type ScriptTemplate,
} from '@naaradh/call-scripts';
import {
  NaaradhError,
  addDays,
  isValidZone,
  newId,
  normalizePhone,
  type PhoneRegion,
} from '@naaradh/shared';
import { audit } from '../audit.js';
import { dataRegionFor } from '../shopify-install.js';
import { Email } from '../web-auth.js';

/**
 * Staff-only operations (P3, closing the go-live gaps): registering numbers in the CLI pool,
 * creating a direct (non-Shopify) merchant, and recording a merchant's DLT principal-entity
 * link. They run with the SERVICE role — the app role cannot insert numbers or tenants by
 * design (migration 0001) — from the IAP console only, and every change is audited as
 * `staff:<email>` so the merchant sees it in their access log.
 */

export interface StaffActor {
  /** Verified staff email (IAP). */
  readonly email: string;
}

const staffAudit = (staff: StaffActor) =>
  ({ actorType: 'user', actorId: `staff:${staff.email}` }) as const;

const Note = z
  .string()
  .trim()
  .min(10, 'write a note of at least 10 characters for the next person')
  .max(500);

// ---------------------------------------------------------------------------------------------
// Numbers (CLI pool, support lines)
// ---------------------------------------------------------------------------------------------

export const NUMBER_SERIES = schema.numberSeries.enumValues;
export const NUMBER_STATUSES = schema.numberStatus.enumValues;
export const PURPOSES = schema.purpose.enumValues;

export type NumberSeries = (typeof NUMBER_SERIES)[number];
export type NumberStatus = (typeof NUMBER_STATUSES)[number];
export type Purpose = (typeof PURPOSES)[number];

const Region = z
  .string()
  .trim()
  .length(2)
  .transform((s) => s.toUpperCase());

/** Names of the engines that may dial from a number; the registry enforces the real list. */
const Engine = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,31}$/, 'engine must be a vendor key such as bolna');

const Provider = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,39}$/, 'provider must be a short lowercase name such as exotel');

export const NumberInput = z
  .object({
    /** Any format; normalised to E.164 in `region`. */
    e164: z.string().trim().min(5).max(32),
    region: Region.default('IN'),
    series: z.enum(NUMBER_SERIES),
    provider: Provider,
    engine: Engine,
    /** What the TSP allows on this number (Q-01). Empty = inbound-only / unusable for outbound. */
    purposeAllowed: z.array(z.enum(PURPOSES)).max(3).default([]),
    /** Evidence for the series decision — the TSP letter reference. Required with any purpose. */
    provisioningNote: z.string().trim().max(500).default(''),
    tenantId: z.string().trim().max(40).optional(),
    inboundProfileId: z.string().trim().max(40).optional(),
    inboundEnabled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.purposeAllowed.length > 0 && v.provisioningNote.length < 10)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provisioningNote'],
        message: 'a number with purposes needs the TSP evidence note (Q-01)',
      });
    if (v.inboundProfileId !== undefined && v.tenantId === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantId'],
        message: 'an inbound profile needs the owning tenant',
      });
    if (v.inboundEnabled && v.inboundProfileId === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inboundProfileId'],
        message: 'inbound needs a profile to answer with',
      });
  });
export type NumberInput = z.infer<typeof NumberInput>;

export const NumberPurposesInput = z.object({
  purposeAllowed: z.array(z.enum(PURPOSES)).max(3),
  provisioningNote: Note,
});

export const NumberAssignInput = z
  .object({
    tenantId: z.string().trim().max(40).optional(),
    inboundProfileId: z.string().trim().max(40).optional(),
    inboundEnabled: z.boolean().default(false),
    note: Note,
  })
  .superRefine((v, ctx) => {
    if (v.inboundProfileId !== undefined && v.tenantId === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantId'],
        message: 'an inbound profile needs the owning tenant',
      });
    if (v.inboundEnabled && v.inboundProfileId === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inboundProfileId'],
        message: 'inbound needs a profile to answer with',
      });
  });

/**
 * P6-ENG-2 — the attestation a number's calls actually carry, as a person saw it: from a test
 * call to a handset that shows it, or the carrier's report. Never copied from documentation.
 */
export const NumberAttestationInput = z.object({
  attestation: z.enum(['A', 'B', 'C']).nullable(),
  evidence: Note,
});

export const NumberStatusInput = z.object({
  status: z.enum(NUMBER_STATUSES),
  reason: Note,
});

export interface NumberView {
  readonly id: string;
  readonly e164: string;
  readonly region: string;
  readonly series: NumberSeries;
  readonly provider: string;
  readonly engine: string;
  readonly purposeAllowed: readonly Purpose[];
  readonly status: NumberStatus;
  readonly answerRate7d: number | null;
  readonly attempts7d: number;
  readonly inboundEnabled: boolean;
  readonly inboundProfileId: string | null;
  readonly inboundProfileName: string | null;
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly lastUsedAt: Date | null;
  readonly provisioningNote: string | null;
  /** STIR/SHAKEN attestation recorded by staff (P6-ENG-2); North America needs A. */
  readonly attestation: 'A' | 'B' | 'C' | null;
  readonly attestationCheckedAt: Date | null;
  readonly createdAt: Date;
}

/** Every number, pool first then owned, with the last 7 days of outbound use. */
export async function listNumbers(db: Db, now: Date, tenantId?: string): Promise<NumberView[]> {
  const since = addDays(now, -7);
  const attempts = db
    .select({
      numberId: schema.callAttempts.numberId,
      n: sql<number>`count(*)::int`.as('n'),
    })
    .from(schema.callAttempts)
    .where(
      and(eq(schema.callAttempts.direction, 'outbound'), gte(schema.callAttempts.createdAt, since)),
    )
    .groupBy(schema.callAttempts.numberId)
    .as('attempts7d');
  const rows = await db
    .select({
      id: schema.numbers.id,
      e164: schema.numbers.e164,
      region: schema.numbers.region,
      series: schema.numbers.series,
      provider: schema.numbers.provider,
      engine: schema.numbers.engine,
      purposeAllowed: schema.numbers.purposeAllowed,
      status: schema.numbers.status,
      answerRate7d: schema.numbers.answerRate7d,
      inboundEnabled: schema.numbers.inboundEnabled,
      inboundProfileId: schema.numbers.inboundProfileId,
      inboundProfileName: schema.inboundProfiles.name,
      tenantId: schema.numbers.tenantId,
      tenantName: schema.tenants.name,
      lastUsedAt: schema.numbers.lastUsedAt,
      provisioningNote: schema.numbers.provisioningNote,
      attestation: schema.numbers.attestation,
      attestationCheckedAt: schema.numbers.attestationCheckedAt,
      createdAt: schema.numbers.createdAt,
      attempts7d: sql<number | null>`${attempts.n}`,
    })
    .from(schema.numbers)
    .leftJoin(schema.tenants, eq(schema.tenants.id, schema.numbers.tenantId))
    .leftJoin(
      schema.inboundProfiles,
      eq(schema.inboundProfiles.id, schema.numbers.inboundProfileId),
    )
    .leftJoin(attempts, eq(attempts.numberId, schema.numbers.id))
    .where(tenantId === undefined ? sql`true` : eq(schema.numbers.tenantId, tenantId))
    .orderBy(sql`${schema.numbers.tenantId} asc nulls first`, desc(schema.numbers.createdAt));
  return rows.map((r) => ({
    ...r,
    answerRate7d: r.answerRate7d === null ? null : Number(r.answerRate7d),
    attempts7d: r.attempts7d ?? 0,
  }));
}

async function requireTenant(db: Db | Tx, tenantId: string): Promise<void> {
  const [t] = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  if (t === undefined) throw new NaaradhError('NOT_FOUND', 'tenant not found');
}

async function requireProfile(db: Db | Tx, tenantId: string, profileId: string): Promise<void> {
  const [p] = await db
    .select({ id: schema.inboundProfiles.id })
    .from(schema.inboundProfiles)
    .where(
      and(eq(schema.inboundProfiles.id, profileId), eq(schema.inboundProfiles.tenantId, tenantId)),
    )
    .limit(1);
  if (p === undefined)
    throw new NaaradhError('NOT_FOUND', 'inbound profile not found for that tenant');
}

/** Registers a number as `warming`; activation is a separate, audited step. */
export async function registerNumber(
  db: Db,
  staff: StaffActor,
  input: NumberInput,
  now: Date,
): Promise<{ id: string; e164: string }> {
  const parsed = normalizePhone(input.e164, input.region as PhoneRegion);
  if (!parsed.ok) throw new NaaradhError('VALIDATION_FAILED', 'not a valid phone number');
  const e164 = parsed.phone.e164;
  if (parsed.phone.region !== input.region)
    throw new NaaradhError(
      'VALIDATION_FAILED',
      `the number belongs to ${parsed.phone.region}, not ${input.region}`,
    );
  return db.transaction(async (tx) => {
    if (input.tenantId !== undefined) await requireTenant(tx, input.tenantId);
    if (input.tenantId !== undefined && input.inboundProfileId !== undefined)
      await requireProfile(tx, input.tenantId, input.inboundProfileId);
    const [dup] = await tx
      .select({ id: schema.numbers.id })
      .from(schema.numbers)
      .where(eq(schema.numbers.e164, e164))
      .limit(1);
    if (dup !== undefined)
      throw new NaaradhError('VALIDATION_FAILED', 'that number is already registered');
    const id = newId('number');
    await tx.insert(schema.numbers).values({
      id,
      tenantId: input.tenantId ?? null,
      e164,
      region: input.region,
      series: input.series,
      provider: input.provider,
      engine: input.engine,
      purposeAllowed: [...input.purposeAllowed],
      inboundEnabled: input.inboundEnabled,
      inboundProfileId: input.inboundProfileId ?? null,
      status: 'warming',
      provisioningNote: input.provisioningNote === '' ? null : input.provisioningNote,
      createdAt: now,
    });
    await audit(tx, {
      tenantId: input.tenantId ?? null,
      ...staffAudit(staff),
      action: 'number.registered',
      targetType: 'number',
      targetId: id,
      // The number itself is a business line, not customer data, but audit rows stay free of
      // dialable strings on principle (invariant 8): the id is enough to find it.
      after: {
        region: input.region,
        series: input.series,
        provider: input.provider,
        engine: input.engine,
        purpose_allowed: input.purposeAllowed,
        inbound_enabled: input.inboundEnabled,
        note: input.provisioningNote,
      },
    });
    return { id, e164 };
  });
}

async function loadNumber(tx: Tx, id: string) {
  const [n] = await tx.select().from(schema.numbers).where(eq(schema.numbers.id, id)).limit(1);
  if (n === undefined) throw new NaaradhError('NOT_FOUND', 'number not found');
  return n;
}

/** Changes what a number may be used for; the note is the Q-01 evidence for the change. */
export async function setNumberPurposes(
  db: Db,
  staff: StaffActor,
  id: string,
  input: z.infer<typeof NumberPurposesInput>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const n = await loadNumber(tx, id);
    await tx
      .update(schema.numbers)
      .set({ purposeAllowed: [...input.purposeAllowed], provisioningNote: input.provisioningNote })
      .where(eq(schema.numbers.id, id));
    await audit(tx, {
      tenantId: n.tenantId,
      ...staffAudit(staff),
      action: 'number.purposes_changed',
      targetType: 'number',
      targetId: id,
      before: { purpose_allowed: n.purposeAllowed },
      after: { purpose_allowed: input.purposeAllowed, note: input.provisioningNote },
    });
  });
}

export async function setNumberAttestation(
  db: Db,
  staff: StaffActor,
  id: string,
  input: z.infer<typeof NumberAttestationInput>,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const n = await loadNumber(tx, id);
    await tx
      .update(schema.numbers)
      .set({
        attestation: input.attestation,
        attestationCheckedAt: input.attestation === null ? null : now,
      })
      .where(eq(schema.numbers.id, id));
    await audit(tx, {
      tenantId: n.tenantId,
      ...staffAudit(staff),
      action: 'number.attestation_recorded',
      targetType: 'number',
      targetId: id,
      before: { attestation: n.attestation },
      after: { attestation: input.attestation, evidence: input.evidence },
    });
  });
}

/** Moves a number between the pool and a tenant, and picks the profile that answers it. */
export async function assignNumber(
  db: Db,
  staff: StaffActor,
  id: string,
  input: z.infer<typeof NumberAssignInput>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const n = await loadNumber(tx, id);
    if (input.tenantId !== undefined) await requireTenant(tx, input.tenantId);
    if (input.tenantId !== undefined && input.inboundProfileId !== undefined)
      await requireProfile(tx, input.tenantId, input.inboundProfileId);
    await tx
      .update(schema.numbers)
      .set({
        tenantId: input.tenantId ?? null,
        inboundProfileId: input.inboundProfileId ?? null,
        inboundEnabled: input.inboundEnabled,
      })
      .where(eq(schema.numbers.id, id));
    const row = {
      tenantId: n.tenantId,
      ...staffAudit(staff),
      action: 'number.assigned',
      targetType: 'number',
      targetId: id,
      before: {
        tenant_id: n.tenantId,
        inbound_profile_id: n.inboundProfileId,
        inbound_enabled: n.inboundEnabled,
      },
      after: {
        tenant_id: input.tenantId ?? null,
        inbound_profile_id: input.inboundProfileId ?? null,
        inbound_enabled: input.inboundEnabled,
        note: input.note,
      },
    };
    await audit(tx, row);
    // The new owner sees the change in its access log too.
    if (input.tenantId !== undefined && input.tenantId !== n.tenantId)
      await audit(tx, { ...row, tenantId: input.tenantId });
  });
}

const ALLOWED_TRANSITIONS: Readonly<Record<NumberStatus, readonly NumberStatus[]>> = {
  warming: ['active', 'retired'],
  active: ['retired', 'suspended'],
  suspended: ['active', 'retired'],
  retired: ['warming'],
};

/**
 * Status changes are the E-28 rotation lever: `retired` (carrier flagged / answer rate below
 * 25%), `suspended` (paused while investigating), back to `warming` to reintroduce a rested
 * number gently. The reason is written for the next person on call.
 */
export async function setNumberStatus(
  db: Db,
  staff: StaffActor,
  id: string,
  input: z.infer<typeof NumberStatusInput>,
): Promise<{ from: NumberStatus; to: NumberStatus }> {
  return db.transaction(async (tx) => {
    const n = await loadNumber(tx, id);
    if (!ALLOWED_TRANSITIONS[n.status].includes(input.status))
      throw new NaaradhError(
        'VALIDATION_FAILED',
        `a ${n.status} number cannot become ${input.status}`,
      );
    if (input.status === 'active' && n.purposeAllowed.length === 0 && !n.inboundEnabled)
      throw new NaaradhError(
        'VALIDATION_FAILED',
        'set the allowed purposes (or an inbound profile) before activating',
      );
    const lowAnswerRate = n.answerRate7d !== null && Number(n.answerRate7d) < 0.25;
    await tx
      .update(schema.numbers)
      // A reintroduced number starts with no history: the gate treats null as warming (E-28).
      .set({ status: input.status, ...(input.status === 'warming' ? { answerRate7d: null } : {}) })
      .where(eq(schema.numbers.id, id));
    await audit(tx, {
      tenantId: n.tenantId,
      ...staffAudit(staff),
      action:
        input.status === 'retired' && lowAnswerRate
          ? 'cli.retire_low_answer_rate'
          : `number.${input.status}`,
      targetType: 'number',
      targetId: id,
      before: { status: n.status, answer_rate_7d: n.answerRate7d },
      after: { status: input.status, reason: input.reason },
    });
    return { from: n.status, to: input.status };
  });
}

// ---------------------------------------------------------------------------------------------
// Direct merchants (API / website integrations without Shopify)
// ---------------------------------------------------------------------------------------------

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

export const DIRECT_USE_CASES = [
  'cod_confirm',
  'abandoned_cart',
  'lead_callback',
  'feedback',
] as const;

export const DirectTenantInput = z.object({
  name: z.string().trim().min(2).max(80),
  legalName: z.string().trim().min(2).max(160).optional(),
  country: Region.default('IN'),
  timezone: z.string().trim().default('Asia/Kolkata').refine(isValidZone, 'not an IANA time zone'),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((s) => s.toUpperCase())
    .default('INR'),
  gstin: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(GSTIN, 'GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5'))
    .optional(),
  pan: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(PAN, 'PAN must be 10 characters, e.g. ABCDE1234F'))
    .optional(),
  ownerEmail: Email,
  ownerName: z.string().trim().min(1).max(120).optional(),
  /** Which use cases to create (OFF) with draft scripts for the owner to approve. */
  useCases: z.array(z.enum(DIRECT_USE_CASES)).min(1).default(['cod_confirm']),
  defaultLocale: z.enum(['hi-IN', 'en-IN']).default('hi-IN'),
  /** Why this merchant is being created by hand (pilot, custom-app mirror, …). */
  note: Note,
});
export type DirectTenantInput = z.infer<typeof DirectTenantInput>;

export interface DirectTenantResult {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly useCasesCreated: number;
  readonly scriptsCreated: number;
}

const REVIEW_DAYS = 7;

/** Use case → purpose and the default draft scripts the owner will review and approve. */
const DIRECT_USE_CASE_SETUP: Readonly<
  Record<
    (typeof DIRECT_USE_CASES)[number],
    { purpose: Purpose; templates: readonly ScriptTemplate[] }
  >
> = {
  cod_confirm: { purpose: 'transactional', templates: [COD_CONFIRM_HI_IN, COD_CONFIRM_EN_IN] },
  abandoned_cart: {
    purpose: 'promotional',
    templates: [ABANDONED_CART_HI_IN, ABANDONED_CART_EN_IN],
  },
  lead_callback: { purpose: 'service', templates: [LEAD_CALLBACK_EN_IN] },
  feedback: { purpose: 'promotional', templates: [FEEDBACK_HI_IN, FEEDBACK_EN_IN] },
};

/**
 * Creates a tenant in `pending_review` (E-73: 7 days of capped volume, no promotional), its
 * owner, the requested use cases (OFF) and draft scripts. The owner signs in with a magic link
 * from the dashboard's own login page — the console sends no email and holds no mail token.
 */
export async function createDirectTenant(
  db: Db,
  staff: StaffActor,
  input: DirectTenantInput,
  now: Date,
): Promise<DirectTenantResult> {
  const tenantId = newId('tenant');
  const ownerUserId = newId('user');
  await db.transaction(async (tx) => {
    await tx.insert(schema.tenants).values({
      id: tenantId,
      name: input.name,
      legalName: input.legalName ?? null,
      country: input.country,
      dataRegion: dataRegionFor(input.country),
      timezone: input.timezone,
      currency: input.currency,
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      status: 'pending_review',
      reviewUntil: addDays(now, REVIEW_DAYS),
      createdAt: now,
    });
    await tx.insert(schema.users).values({
      id: ownerUserId,
      tenantId,
      email: input.ownerEmail,
      name: input.ownerName ?? null,
      role: 'owner',
      createdAt: now,
    });
    await audit(tx, {
      tenantId,
      ...staffAudit(staff),
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: tenantId,
      after: {
        country: input.country,
        timezone: input.timezone,
        currency: input.currency,
        review_until: addDays(now, REVIEW_DAYS),
        use_cases: input.useCases,
        note: input.note,
      },
    });
    await audit(tx, {
      tenantId,
      ...staffAudit(staff),
      action: 'user.invited',
      targetType: 'user',
      targetId: ownerUserId,
      after: { role: 'owner', by: 'staff' },
    });
  });

  // Use cases and draft scripts are written under the tenant, exactly as the Shopify install
  // does through ensureDefaultSetup, so the rows look the same whichever way a merchant arrived.
  const setup = await withTenant(db, tenantId, async (tx) => {
    let useCasesCreated = 0;
    let scriptsCreated = 0;
    for (const kind of new Set(input.useCases)) {
      const spec = DIRECT_USE_CASE_SETUP[kind];
      const useCaseId = newId('useCase');
      await tx.insert(schema.useCases).values({
        id: useCaseId,
        tenantId,
        kind,
        purpose: spec.purpose,
        enabled: false,
        config: {
          defaultLocale: kind === 'lead_callback' ? 'en-IN' : input.defaultLocale,
          minOrderValuePaise: 0,
          pilotPercent: 100,
        },
      });
      useCasesCreated += 1;
      for (const template of spec.templates) {
        await tx.insert(schema.scripts).values({
          id: newId('script'),
          tenantId,
          useCaseId,
          version: 1,
          locale: template.locale,
          body: template,
          status: 'draft',
        });
        scriptsCreated += 1;
      }
    }
    await audit(tx, {
      tenantId,
      ...staffAudit(staff),
      action: 'tenant.default_setup',
      targetType: 'tenant',
      targetId: tenantId,
      after: { use_cases: useCasesCreated, scripts: scriptsCreated },
    });
    return { useCasesCreated, scriptsCreated };
  });
  return { tenantId, ownerUserId, ...setup };
}

// ---------------------------------------------------------------------------------------------
// DLT principal-entity link (SPEC §3.3)
// ---------------------------------------------------------------------------------------------

const DLT_PE_ID = /^[0-9]{15,20}$/;

export const DltLinkInput = z.object({
  /** The merchant's PE id on the DLT portal; keeps the stored one when omitted. */
  dltPeId: z.string().trim().regex(DLT_PE_ID, 'a DLT PE id is 15–20 digits').optional(),
  linked: z.boolean(),
  /** What was checked: portal screenshot / TSP confirmation reference, date. */
  evidence: Note,
});

/**
 * Promotional purposes are gated on `dlt_linked_at` (gate step for DLT). Only staff may set it,
 * after checking on the DLT portal that the merchant's PE authorised Naaradh as its telemarketer.
 */
export async function setDltLink(
  db: Db,
  staff: StaffActor,
  tenantId: string,
  input: z.infer<typeof DltLinkInput>,
  now: Date,
): Promise<{ dltPeId: string; linkedAt: Date | null }> {
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select({ dltPeId: schema.tenants.dltPeId, dltLinkedAt: schema.tenants.dltLinkedAt })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
      .limit(1);
    if (t === undefined) throw new NaaradhError('NOT_FOUND', 'tenant not found');
    const peId = input.dltPeId ?? t.dltPeId;
    if (peId === null)
      throw new NaaradhError('VALIDATION_FAILED', 'enter the PE id before marking the link');
    const linkedAt = input.linked ? now : null;
    await tx
      .update(schema.tenants)
      .set({ dltPeId: peId, dltLinkedAt: linkedAt })
      .where(eq(schema.tenants.id, tenantId));
    await audit(tx, {
      tenantId,
      ...staffAudit(staff),
      action: input.linked ? 'tenant.dlt_linked' : 'tenant.dlt_unlinked',
      targetType: 'tenant',
      targetId: tenantId,
      before: { dlt_pe_id: t.dltPeId, dlt_linked_at: t.dltLinkedAt },
      after: { dlt_pe_id: peId, dlt_linked_at: linkedAt, evidence: input.evidence },
    });
    return { dltPeId: peId, linkedAt };
  });
}

/** Tenants whose PE id is set but not yet linked — the console's to-do list. */
export async function pendingDltLinks(
  db: Db,
): Promise<{ id: string; name: string; dltPeId: string }[]> {
  const rows = await db
    .select({ id: schema.tenants.id, name: schema.tenants.name, dltPeId: schema.tenants.dltPeId })
    .from(schema.tenants)
    .where(and(sql`${schema.tenants.dltPeId} is not null`, isNull(schema.tenants.dltLinkedAt)))
    .orderBy(schema.tenants.name)
    .limit(100);
  return rows.flatMap((r) => (r.dltPeId === null ? [] : [{ ...r, dltPeId: r.dltPeId }]));
}
