import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withTenant, type Db } from '@naaradh/db';
import { upsertAppointment, type PhoneKeys } from '@naaradh/pipeline';
import { NaaradhError, isValidZone, type PhoneRegion } from '@naaradh/shared';
import { requireScope } from '../auth.js';

/**
 * PUT /v1/appointments/{ref}, GET /v1/appointments/{ref}, GET /v1/appointments (ADR-0011 §7).
 *
 * The merchant's system owns its appointments; Naaradh keeps a copy so it can place ONE
 * confirmation call in the envelope (24 h to 2 h before, recipient's zone, 09:00–21:00) and so
 * the support line can answer "do I have an appointment?". Send the same appointment as often as
 * you like: moving it moves the call, cancelling it cancels the call.
 *
 * Deliberately no field for a reason, a note or anything clinical (ADR-0011 §8).
 */
export const AppointmentBody = z.object({
  phone: z.string().min(5).max(32).nullable().default(null),
  phone_region: z.string().length(2).default('IN'),
  name: z.string().trim().max(80).nullable().default(null),
  /** What the appointment is for, as the agent should say it ("blood test", "colour"). */
  service: z.string().trim().max(80).nullable().default(null),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }).nullable().default(null),
  /** IANA zone the appointment is in — what the customer hears, and the window it is called in. */
  timezone: z.string().max(64).refine(isValidZone, 'not a valid IANA time zone'),
  status: z
    .enum(['scheduled', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show'])
    .default('scheduled'),
  /** The calendar it belongs to, when the merchant connected one. */
  calendar_id: z.string().trim().max(40).nullable().default(null),
});

export interface AppointmentRouteDeps {
  readonly db: Db;
  readonly keys: PhoneKeys;
  readonly clock: () => Date;
}

const Ref = z.string().trim().min(1).max(200);

const view = (a: {
  id: string;
  externalId: string;
  service: string | null;
  startsAt: Date;
  endsAt: Date | null;
  timezone: string;
  status: string;
  intentId: string | null;
  providerRef: string | null;
  erasedAt: Date | null;
}) => ({
  appointment_id: a.id,
  ref: a.externalId,
  service: a.service,
  starts_at: a.startsAt.toISOString(),
  ends_at: a.endsAt?.toISOString() ?? null,
  timezone: a.timezone,
  status: a.status,
  /** The confirmation call, once one is queued; null while it is not due or not possible. */
  intent_id: a.intentId,
  provider_ref: a.providerRef,
  erased: a.erasedAt !== null,
});

export function registerAppointmentRoutes(app: FastifyInstance, deps: AppointmentRouteDeps): void {
  app.put<{ Params: { ref: string } }>('/v1/appointments/:ref', async (request, reply) => {
    const auth = requireScope(request, 'appointments:write');
    const ref = Ref.parse(request.params.ref);
    const body = AppointmentBody.parse(request.body);
    const now = deps.clock();
    const startsAt = new Date(body.starts_at);
    const endsAt = body.ends_at === null ? null : new Date(body.ends_at);
    if (endsAt !== null && endsAt <= startsAt)
      throw new NaaradhError('VALIDATION_FAILED', 'ends_at must be after starts_at');

    const result = await withTenant(deps.db, auth.tenantId, async (tx) => {
      if (body.calendar_id !== null) {
        const [calendar] = await tx
          .select({ id: schema.calendars.id })
          .from(schema.calendars)
          .where(
            and(
              eq(schema.calendars.tenantId, auth.tenantId),
              eq(schema.calendars.id, body.calendar_id),
            ),
          )
          .limit(1);
        if (calendar === undefined) throw new NaaradhError('NOT_FOUND', 'calendar not found');
      }
      return upsertAppointment(tx, deps.keys, {
        tenantId: auth.tenantId,
        source: 'api',
        externalId: ref,
        calendarId: body.calendar_id,
        rawPhone: body.phone,
        defaultRegion: body.phone_region.toUpperCase() as PhoneRegion,
        customerName: body.name,
        service: body.service,
        startsAt,
        endsAt,
        timezone: body.timezone,
        status: body.status,
        now,
      });
    });
    if (result.kind === 'skipped')
      return reply.code(200).send({ ref, status: 'skipped', reason: result.reason });
    return reply
      .code(result.created ? 201 : 200)
      .send({ ref, appointment_id: result.appointmentId, status: 'recorded' });
  });

  app.get<{ Params: { ref: string } }>('/v1/appointments/:ref', async (request) => {
    const auth = requireScope(request, 'appointments:read');
    const ref = Ref.parse(request.params.ref);
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const [a] = await tx
        .select()
        .from(schema.appointments)
        .where(
          and(
            eq(schema.appointments.tenantId, auth.tenantId),
            eq(schema.appointments.source, 'api'),
            eq(schema.appointments.externalId, ref),
          ),
        )
        .limit(1);
      if (a === undefined) throw new NaaradhError('NOT_FOUND', 'appointment not found');
      return view(a);
    });
  });

  app.get('/v1/appointments', async (request) => {
    const auth = requireScope(request, 'appointments:read');
    const query = z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const from = query.from === undefined ? deps.clock() : new Date(query.from);
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.appointments)
        .where(
          and(
            eq(schema.appointments.tenantId, auth.tenantId),
            gte(schema.appointments.startsAt, from),
          ),
        )
        .orderBy(schema.appointments.startsAt)
        .limit(query.limit);
      return { appointments: rows.map(view) };
    });
  });

  /** The calendars a merchant connected — read-only here; they are configured in the dashboard. */
  app.get('/v1/calendars', async (request) => {
    const auth = requireScope(request, 'appointments:read');
    return withTenant(deps.db, auth.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: schema.calendars.id,
          provider: schema.calendars.provider,
          name: schema.calendars.name,
          timezone: schema.calendars.timezone,
          slotMinutes: schema.calendars.slotMinutes,
          status: schema.calendars.status,
          lastError: schema.calendars.lastError,
        })
        .from(schema.calendars)
        .where(eq(schema.calendars.tenantId, auth.tenantId))
        .orderBy(desc(schema.calendars.createdAt));
      return {
        calendars: rows.map((c) => ({
          calendar_id: c.id,
          provider: c.provider,
          name: c.name,
          timezone: c.timezone,
          slot_minutes: c.slotMinutes,
          status: c.status,
          error: c.lastError,
        })),
      };
    });
  });
}
