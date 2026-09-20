import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type DbOrTx } from '@naaradh/db';
import { CALENDAR_PROVIDERS } from '@naaradh/calendar';
import { NaaradhError, isValidZone, newId } from '@naaradh/shared';
import { audit } from '../audit.js';

/**
 * Connecting a calendar (ADR-0011 §5) is staff work, like registering a number or linking a
 * DLT principal entity: it carries a provider credential, and Naaradh stores only a Secret
 * Manager reference to it — never the key. The merchant then sees the calendar, its slot length
 * and any provider error in their dashboard, and the agent offers only what the provider offers.
 */

export const CalendarInput = z.object({
  provider: z.enum(CALENDAR_PROVIDERS),
  /** Provider's event type / calendar id the slots come from. */
  external_id: z.string().trim().min(1).max(120),
  /** What the merchant calls it — the agent says this, so it must be a service name. */
  name: z.string().trim().min(2).max(80),
  timezone: z.string().max(64).refine(isValidZone, 'not a valid IANA time zone'),
  slot_minutes: z.number().int().min(5).max(480).default(30),
  /**
   * `sm://projects/…/secrets/<name>` in production (created by a human with gcloud), or
   * `inline:<key>` locally. Never the raw key in production — the resolver refuses it.
   */
  credentials_secret_ref: z.string().trim().min(3).max(300).nullable().default(null),
  /** Provider quirks only: Cal.com's `eventTypeId`, `attendeeEmail`. No credentials. */
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type CalendarInput = z.infer<typeof CalendarInput>;

export interface CalendarView {
  readonly id: string;
  readonly provider: string;
  readonly externalId: string;
  readonly name: string;
  readonly timezone: string;
  readonly slotMinutes: number;
  readonly status: string;
  readonly lastError: string | null;
  readonly hasCredential: boolean;
  readonly createdAt: Date;
}

export async function listCalendars(tx: DbOrTx, tenantId: string): Promise<CalendarView[]> {
  const rows = await tx
    .select()
    .from(schema.calendars)
    .where(eq(schema.calendars.tenantId, tenantId))
    .orderBy(desc(schema.calendars.createdAt));
  return rows.map((c) => ({
    id: c.id,
    provider: c.provider,
    externalId: c.externalId,
    name: c.name,
    timezone: c.timezone,
    slotMinutes: c.slotMinutes,
    status: c.status,
    lastError: c.lastError,
    hasCredential: c.credentialsSecretRef !== null,
    createdAt: c.createdAt,
  }));
}

export async function createCalendar(
  tx: DbOrTx,
  input: CalendarInput & { readonly tenantId: string; readonly by: string; readonly at: Date },
): Promise<string> {
  if (input.provider !== 'manual' && input.credentials_secret_ref === null)
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'a hosted calendar needs a credentials secret reference (sm://… or inline:… locally)',
    );
  if (
    (input.credentials_secret_ref ?? '').startsWith('sk_') ||
    /^[A-Za-z0-9._-]{40,}$/.test(input.credentials_secret_ref ?? '')
  )
    // A pasted API key is a credential in the database: refuse, name the mistake.
    throw new NaaradhError(
      'VALIDATION_FAILED',
      'that looks like the key itself — store it in Secret Manager and paste the sm:// reference',
    );
  const id = newId('calendar');
  await tx.insert(schema.calendars).values({
    id,
    tenantId: input.tenantId,
    provider: input.provider,
    externalId: input.external_id,
    name: input.name,
    timezone: input.timezone,
    slotMinutes: input.slot_minutes,
    credentialsSecretRef: input.credentials_secret_ref,
    config: input.config,
    status: 'active',
  });
  await audit(tx, {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.by,
    action: 'calendar.connected',
    targetType: 'calendar',
    targetId: id,
    after: {
      provider: input.provider,
      external_id: input.external_id,
      timezone: input.timezone,
      slot_minutes: input.slot_minutes,
      // The reference, never the secret.
      credentials_secret_ref: input.credentials_secret_ref,
    },
  });
  return id;
}

export async function setCalendarStatus(
  tx: DbOrTx,
  input: {
    readonly tenantId: string;
    readonly calendarId: string;
    readonly status: 'active' | 'disabled';
    readonly by: string;
    readonly reason: string;
    readonly at: Date;
  },
): Promise<boolean> {
  if (input.reason.trim().length < 10)
    throw new TypeError('a reason of at least 10 characters is required');
  const rows = await tx
    .update(schema.calendars)
    .set({ status: input.status, ...(input.status === 'active' ? { lastError: null } : {}) })
    .where(
      and(eq(schema.calendars.tenantId, input.tenantId), eq(schema.calendars.id, input.calendarId)),
    )
    .returning({ id: schema.calendars.id });
  if (rows.length === 0) return false;
  await audit(tx, {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.by,
    action: input.status === 'active' ? 'calendar.enabled' : 'calendar.disabled',
    targetType: 'calendar',
    targetId: input.calendarId,
    after: { reason: input.reason.slice(0, 500) },
  });
  return true;
}

export interface UpcomingAppointment {
  readonly id: string;
  readonly ref: string;
  readonly service: string | null;
  readonly startsAt: Date;
  readonly timezone: string;
  readonly status: string;
  readonly source: string;
  readonly intentId: string | null;
  readonly reminderDecidedAt: Date | null;
  readonly providerError: string | null;
}

/** What the merchant sees: the diary Naaradh will call about, and whether a call is queued. */
export async function upcomingAppointments(
  tx: DbOrTx,
  tenantId: string,
  from: Date,
  limit = 100,
): Promise<UpcomingAppointment[]> {
  const rows = await tx
    .select()
    .from(schema.appointments)
    .where(and(eq(schema.appointments.tenantId, tenantId), gte(schema.appointments.startsAt, from)))
    .orderBy(schema.appointments.startsAt)
    .limit(limit);
  return rows.map((a) => ({
    id: a.id,
    ref: a.externalId,
    service: a.service,
    startsAt: a.startsAt,
    timezone: a.timezone,
    status: a.status,
    source: a.source,
    intentId: a.intentId,
    reminderDecidedAt: a.reminderSweptAt,
    providerError: a.providerError,
  }));
}
