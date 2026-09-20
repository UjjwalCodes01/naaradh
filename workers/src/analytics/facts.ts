import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '@naaradh/db';
import { BILLABLE_OUTCOMES, INBOUND_BILLING_ROUNDING_SEC } from '@naaradh/compliance';
import { NaaradhError } from '@naaradh/shared';

/**
 * Daily call facts (P2-INF-2 / P2-WEB-2): the rows the nightly export loads into BigQuery
 * `daily_call_facts` (infra/modules/bigquery/main.tf) for RTO analytics. One row per
 * (tenant, day, direction, use_case, outcome, billable).
 *
 * Invariant 8 is the design constraint here, not an afterthought: nothing per-subject leaves
 * the database. No phone number, no hash, no contact/attempt/order/intent id, no order
 * reference, no extraction, no name — tenant ids and coarse sums only. `DAILY_FACT_KEYS` is the
 * complete column list and the row schema is `.strict()`, so a column added to the query by
 * mistake fails validation instead of reaching the export.
 *
 * Day assignment: an attempt belongs to the Asia/Kolkata calendar day of its `ended_at`, or of
 * its `created_at` when it never got one (failed at dispatch, cancelled before dial). Attempts
 * still live at export time are left out: reconcile stamps `ended_at` when it ends them, and
 * counting them by `created_at` now would count them again tomorrow.
 *
 * billable — invariant 11, both belt and braces: the stored `call_outcomes.billable` verdict
 * (which also carries E-25 minimum speech and E-40 supersession) AND human answered AND the
 * outcome in the fixed billable five from compliance. Inbound is never outcome-billed.
 *
 * minutes — inbound only: connected seconds rounded UP per call, exactly as
 * `meterInboundCall` does (`ev.billableSec ?? ev.durationSec`, `INBOUND_BILLING_ROUNDING_SEC`).
 * `billedMinutes()` from @naaradh/pipeline is the same arithmetic but a JS function; a single
 * GROUP BY statement cannot call it, so the SQL mirrors it with the shared constant and the
 * integration test cross-checks the two.
 *
 * amount_minor — the billing ledger rows LINKED to the attempts of that day: `kind='outcome'`
 * rows by outcome id, `kind='minute'` rows by attempt id (`<attempt_id>` and
 * `<attempt_id>:overage`). Credits (dispute refunds, keyed by dispute id) are not per-attempt
 * and are not included. Null when nothing was metered for the group.
 *
 * pincode_band / state — always null today. The order cache stores only `pincode_hash`
 * (AGENTS §4) and no state; a band cannot be derived from a hash. When a coarse
 * `pincode_band`/`state` column exists on `orders`, fill it here and add it to the GROUP BY.
 */

export const FACT_ZONE = 'Asia/Kolkata';

/** Exactly the BigQuery table's columns, in order. */
export const DAILY_FACT_KEYS = [
  'tenant_id',
  'day',
  'direction',
  'use_case',
  'outcome',
  'billable',
  'attempts',
  'human_speech_sec',
  'minutes',
  'amount_minor',
  'currency',
  'pincode_band',
  'state',
] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** pg returns int8 sums as strings; everything here is far below 2^53. */
const int = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int());
const intOrNull = z.preprocess(
  (v) => (typeof v === 'string' ? Number(v) : v),
  z.number().int().nullable(),
);

export const dailyFactSchema = z
  .object({
    tenant_id: z.string().regex(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/),
    day: z.string().regex(DAY_RE),
    direction: z.enum(['inbound', 'outbound']),
    use_case: z.string().nullable(),
    outcome: z.string().nullable(),
    billable: z.boolean(),
    attempts: int.pipe(z.number().positive()),
    human_speech_sec: intOrNull,
    minutes: intOrNull,
    amount_minor: intOrNull,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    pincode_band: z.string().max(2).nullable(),
    state: z.string().max(64).nullable(),
  })
  .strict();

export type DailyFact = z.infer<typeof dailyFactSchema>;

/** Attempt statuses that will still receive an `ended_at` (see the header comment). */
const LIVE_STATUSES = [
  'DISPATCHING',
  'UNCERTAIN',
  'DIALING',
  'RINGING',
  'IN_CONVERSATION',
  'TRANSFERRING',
] as const;

/** The UTC instants bounding a local calendar day; throws on anything that is not a real date. */
export function localDayBounds(day: string): { readonly start: Date; readonly end: Date } {
  const start = DateTime.fromISO(day, { zone: FACT_ZONE });
  if (!DAY_RE.test(day) || !start.isValid || start.toISODate() !== day) {
    throw new NaaradhError('VALIDATION_FAILED', 'analytics: day must be YYYY-MM-DD', {
      context: { day },
    });
  }
  return {
    start: start.startOf('day').toJSDate(),
    end: start.startOf('day').plus({ days: 1 }).toJSDate(),
  };
}

/**
 * All tenants' facts for one Asia/Kolkata day. Read-only, service role (the export is the
 * documented cross-tenant job), one statement.
 */
export async function dailyCallFacts(service: Db, day: string): Promise<DailyFact[]> {
  const { start, end } = localDayBounds(day);
  // Fixed enum constants, never user input: rendered as array literals (a JS array bound as a
  // parameter becomes a record, not a Postgres array).
  const literal = (values: readonly string[]) =>
    sql.raw(`array[${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(',')}]::text[]`);
  const billable = literal(BILLABLE_OUTCOMES);
  const live = literal(LIVE_STATUSES);
  const res = await service.execute(sql`
    with attempt as (
      select
        a.tenant_id,
        a.id as attempt_id,
        a.direction::text as direction,
        coalesce(
          i.use_case::text,
          case when a.direction = 'inbound' then 'inbound_support' end
        ) as use_case,
        o.id as outcome_id,
        o.outcome::text as outcome,
        (
          a.direction = 'outbound'
          and a.answered_by = 'human'
          and coalesce(o.billable, false)
          and o.outcome::text = any(${billable})
        ) as billable,
        a.human_speech_sec,
        case
          when a.direction = 'inbound' then
            ceil(
              greatest(coalesce(a.billable_sec, a.duration_sec, 0), 0)::numeric
                / ${INBOUND_BILLING_ROUNDING_SEC}::numeric
            )::int
        end as minutes
      from call_attempts a
      left join call_intents i on i.id = a.intent_id
      left join call_outcomes o on o.attempt_id = a.id
      where coalesce(a.ended_at, a.created_at) >= ${start}
        and coalesce(a.ended_at, a.created_at) < ${end}
        and (a.ended_at is not null or a.status::text <> all(${live}))
    ),
    charge as (
      select
        x.attempt_id,
        sum(l.total_minor) as amount_minor,
        max(l.currency) as currency
      from attempt x
      join billing_ledger l
        on l.tenant_id = x.tenant_id
       and (
         (l.kind = 'outcome' and l.ref = x.outcome_id)
         or (l.kind = 'minute' and l.ref in (x.attempt_id, x.attempt_id || ':overage'))
       )
      group by x.attempt_id
    )
    select
      x.tenant_id,
      ${day}::text as day,
      x.direction,
      x.use_case,
      x.outcome,
      x.billable,
      count(*)::int as attempts,
      sum(x.human_speech_sec)::bigint as human_speech_sec,
      sum(x.minutes)::bigint as minutes,
      sum(c.amount_minor)::bigint as amount_minor,
      max(c.currency) as currency,
      null::text as pincode_band,
      null::text as state
    from attempt x
    left join charge c on c.attempt_id = x.attempt_id
    group by x.tenant_id, x.direction, x.use_case, x.outcome, x.billable
    order by x.tenant_id, x.direction, x.use_case nulls last, x.outcome nulls last, x.billable
  `);
  return res.rows.map((row, index) => {
    const parsed = dailyFactSchema.safeParse(row);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new NaaradhError('INTERNAL', 'analytics: fact row failed validation', {
        context: {
          day,
          row: index,
          path: first?.path.join('.') ?? '',
          issue: first?.message ?? '',
        },
      });
    }
    return parsed.data;
  });
}
