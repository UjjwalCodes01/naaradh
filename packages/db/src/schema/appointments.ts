import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, smallint, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, idFormat, phoneHash, ts, updatedAt } from './columns.js';
import { callAttempts, callIntents } from './calls.js';
import { contacts } from './contacts.js';
import { appointmentStatus, calendarProvider, calendarStatus } from './enums.js';
import { tenants } from './tenants.js';

/**
 * ADR-0011 — the appointments vertical. `calendars` is where slots come from (one provider
 * event type per row); `appointments` is what was agreed with a customer, whoever agreed it:
 * the merchant's own system through the API, the provider, or the agent on a call.
 *
 * The row holds the phone hash, a contact link and the service name — never a reason for the
 * visit, a note or a clinical detail (ADR-0011 §8).
 */
export const calendars = pgTable(
  'calendars',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: calendarProvider('provider').notNull(),
    /** The provider's event type / calendar id the slots are read from. */
    externalId: text('external_id').notNull(),
    /** What the merchant calls it ("Blood test", "Colour service") — spoken on calls. */
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    /** Secret Manager reference for the provider credential. NEVER the credential itself. */
    credentialsSecretRef: text('credentials_secret_ref'),
    slotMinutes: smallint('slot_minutes').notNull().default(30),
    /**
     * Provider quirks the adapter needs and nothing else: Cal.com's event type slug and
     * username, the attendee email bookings are made under (providers require one; Naaradh
     * asks customers for no email). Never a credential — that is `credentials_secret_ref`.
     */
    config: jsonb('config').notNull().default({}),
    status: calendarStatus('status').notNull().default('active'),
    lastError: text('last_error'),
    lastCheckedAt: ts('last_checked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('calendars_id_format', idFormat(t.id, 'cal')),
    check('calendars_slot_minutes', sql`${t.slotMinutes} between 5 and 480`),
    uniqueIndex('calendars_provider_uq').on(t.tenantId, t.provider, t.externalId),
  ],
).enableRLS();

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    calendarId: text('calendar_id').references(() => calendars.id),
    contactId: text('contact_id').references(() => contacts.id),
    phoneHash: phoneHash(),
    /** Who told us about it: `api`, the provider, or `voice` when the agent booked it. */
    source: text('source').notNull(),
    /** The merchant's or provider's id for it. */
    externalId: text('external_id').notNull(),
    /** Service name spoken on the call; no reason-for-visit, ever. */
    service: text('service'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at'),
    /** IANA zone the appointment is in — what the customer hears. */
    timezone: text('timezone').notNull(),
    status: appointmentStatus('status').notNull().default('scheduled'),
    /** The provider's booking id, when a provider holds the slot. */
    providerRef: text('provider_ref'),
    /** The reminder/confirmation intent, once one has been created. */
    intentId: text('intent_id').references(() => callIntents.id),
    /** Set when the agent booked it on a call (inbound or outbound). */
    bookedByAttemptId: text('booked_by_attempt_id').references(() => callAttempts.id),
    reminderSweptAt: ts('reminder_swept_at'),
    /**
     * A cancellation decided on a call has to reach the provider too, and that is a network
     * call: the reconcile worker does it and stamps this. Null with `status = 'cancelled'` and
     * a `provider_ref` means "still to tell the provider".
     */
    providerCancelledAt: ts('provider_cancelled_at'),
    providerError: text('provider_error'),
    erasedAt: ts('erased_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('appointments_id_format', idFormat(t.id, 'apt')),
    check(
      'appointments_ends_after_starts',
      sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`,
    ),
    uniqueIndex('appointments_source_uq').on(t.tenantId, t.source, t.externalId),
    // The reminder sweep: future appointments still needing a confirmation call.
    index('appointments_reminder_idx')
      .on(t.startsAt)
      .where(
        sql`status in ('scheduled','rescheduled') and intent_id is null and erased_at is null`,
      ),
    index('appointments_phone_idx').on(t.tenantId, t.phoneHash),
  ],
).enableRLS();
