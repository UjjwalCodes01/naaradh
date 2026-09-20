import { sql } from 'drizzle-orm';
import type { Db } from '@naaradh/db';

export type ClaimedIntent = { id: string; tenant_id: string };

/**
 * ADR-0005: the claim. One statement, SKIP LOCKED, highest priority first. Runs as the
 * SERVICE role because it spans tenants; everything after it runs as the app role inside
 * the tenant's context. The row flips to DISPATCHING so a second dispatcher instance skips
 * it; reconcile frees claims older than two minutes (crash recovery).
 */
export async function claimDueIntents(
  service: Db,
  workerId: string,
  now: Date,
  limit: number,
): Promise<ClaimedIntent[]> {
  const result = await service.execute<ClaimedIntent>(sql`
    with due as (
      select id from call_intents
      where status in ('SCHEDULED', 'RETRY_SCHEDULED')
        and next_attempt_at is not null
        and next_attempt_at <= ${now}
      order by priority desc, next_attempt_at asc
      for update skip locked
      limit ${limit}
    )
    update call_intents ci
    set status = 'DISPATCHING', claimed_at = ${now}, claimed_by = ${workerId}
    from due
    where ci.id = due.id
    returning ci.id, ci.tenant_id
  `);
  return result.rows;
}

/** Reconcile: a DISPATCHING claim with no live attempt and older than `staleAfter` goes back to the queue. */
export async function releaseStaleClaims(service: Db, staleBefore: Date): Promise<number> {
  const result = await service.execute<{ id: string }>(sql`
    update call_intents ci
    set status = 'SCHEDULED', claimed_at = null, claimed_by = null, next_attempt_at = now()
    where ci.status = 'DISPATCHING'
      and ci.claimed_at < ${staleBefore}
      and not exists (
        select 1 from call_attempts a
        where a.intent_id = ci.id
          and a.status in ('DISPATCHING','UNCERTAIN','DIALING','RINGING','IN_CONVERSATION','TRANSFERRING')
      )
    returning ci.id
  `);
  return result.rows.length;
}
