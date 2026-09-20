import type {
  AnsweredBy,
  EndedResult,
  EndReason,
  EngineCallSnapshot,
  EngineEvent,
  Turn,
} from '@naaradh/engines-core';
import type { BolnaExecution } from './wire.js';

/**
 * Bolna's execution record → our normalised events (P1-ENG-3).
 *
 * Bolna POSTs the whole execution to the agent's webhook each time its `status` changes, so one
 * call produces several deliveries with the same `id`:
 *
 *   scheduled, queued, rescheduled, initiated   nothing we track            → ignored (null)
 *   ringing                                     → call.ringing
 *   in-progress                                 → call.answered
 *   call-disconnected                           the line dropped, but duration, cost, transcript
 *                                               and extraction are still empty → ignored; the
 *                                               result is `completed`, a few seconds later
 *   completed                                   → call.ended  (with everything)
 *   no-answer, busy, canceled, stopped          → call.ended  (never connected)
 *   failed, error, balance-low                  → call.failed
 *
 * Bolna does NOT sign its webhooks (it publishes source IPs instead), so every event is a hint:
 * the results-consumer re-fetches the execution and writes outcomes and billing from THAT
 * (invariant 9, E-23). `snapshotOf` is therefore the part that matters most here.
 *
 * `status: completed` does not mean anybody spoke: Bolna derives it from the carrier's
 * lifecycle, and a rejected call can arrive as `completed` with `conversation_duration: 0`.
 * A call is "connected" only when the conversation lasted.
 */

const SEQUENCE: Readonly<Record<string, number>> = {
  scheduled: 0,
  rescheduled: 0,
  queued: 1,
  initiated: 2,
  ringing: 3,
  'in-progress': 4,
  'call-disconnected': 5,
  completed: 6,
  'no-answer': 6,
  busy: 6,
  canceled: 6,
  stopped: 6,
  failed: 6,
  error: 6,
  'balance-low': 6,
};

export const ENDED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'no-answer',
  'busy',
  'canceled',
  'stopped',
]);
export const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'error', 'balance-low']);

/** Outcomes the agent records that are also end reasons (the guardrails end the call on them). */
const OUTCOME_REASON: Readonly<Record<string, EndReason>> = {
  opt_out: 'opt_out',
  wrong_number: 'wrong_number',
  minor_answered: 'minor_answered',
  recording_refused: 'recording_refused',
};

export function connected(x: BolnaExecution): boolean {
  return x.status === 'completed' && (x.conversation_duration ?? 0) > 0;
}

export function answeredBy(x: BolnaExecution): AnsweredBy {
  if (x.answered_by_voice_mail === true) return 'machine';
  return connected(x) ? 'human' : 'unknown';
}

/**
 * Post-call extraction. We ask for one flat JSON object (`outcome`, `confidence`, …), but
 * Bolna's newer "dispositions" arrive nested as Category → Name → { objective, subjective }.
 * Both are accepted: nested values are lifted to `name_in_snake_case: objective ?? subjective`.
 */
export function extractedOf(x: BolnaExecution): Readonly<Record<string, unknown>> | null {
  const data = x.extracted_data;
  if (data === null || data === undefined || Object.keys(data).length === 0) return null;
  if ('outcome' in data) return data;
  const flat: Record<string, unknown> = {};
  for (const category of Object.values(data)) {
    if (category === null || typeof category !== 'object' || Array.isArray(category)) continue;
    for (const [name, value] of Object.entries(category as Record<string, unknown>)) {
      // The adapter names typed dispositions `field__i|f|b` (dispositionsFor), because Bolna
      // returns every answer as text.
      const typed = /^(.*)__([ifb])$/.exec(name.trim());
      const key = (typed?.[1] ?? name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_');
      const raw =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? ((value as Record<string, unknown>)['objective'] ??
            (value as Record<string, unknown>)['subjective'] ??
            null)
          : value;
      flat[key] = typed === null ? raw : coerce(raw, typed[2] ?? '');
    }
  }
  return Object.keys(flat).length === 0 ? data : flat;
}

const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

function coerce(value: unknown, kind: string): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (kind === 'b') return typeof value === 'boolean' ? value : /^(true|yes)$/i.test(text(value));
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return kind === 'i' ? Math.trunc(n) : n;
}

export function endReason(x: BolnaExecution): EndReason {
  switch (x.status) {
    case 'no-answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'canceled':
    case 'stopped':
      return 'cancelled';
    case 'failed':
      return 'carrier_temp_fail';
    case 'error':
    case 'balance-low':
      return 'engine_error';
    default:
      break;
  }
  if (x.answered_by_voice_mail === true) return 'amd_hangup';
  // `completed` with no conversation: the callee rejected, or it rang out. [VERIFY] whether
  // hangup_provider_code tells the two apart on Plivo/Exotel; both retry the same way.
  if (!connected(x)) return 'no_answer';
  const outcome = extractedOf(x)?.['outcome'];
  if (typeof outcome === 'string' && OUTCOME_REASON[outcome] !== undefined)
    return OUTCOME_REASON[outcome];
  if (x.transfer_call_data?.status === 'completed') return 'transfer_completed';
  const by = (x.telephony_data?.hangup_by ?? '').toLowerCase();
  const why = (x.telephony_data?.hangup_reason ?? '').toLowerCase();
  if (why.includes('duration') || why.includes('time limit')) return 'max_duration'; // [VERIFY]
  // On an outbound call the customer is the callee; on an inbound one, the caller.
  const customer = x.telephony_data?.call_type === 'inbound' ? 'caller' : 'callee';
  if (by === customer) return 'customer_hangup';
  return 'completed';
}

/** Naive timestamps (`initiated_at` has no zone) are UTC. */
function dateOf(v: string | null | undefined): Date | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(t) ? null : new Date(t);
}

function durationSec(x: BolnaExecution): number {
  const carrier = Number(x.telephony_data?.duration ?? 0);
  const talk = x.conversation_duration ?? 0;
  return Math.round(Math.max(Number.isFinite(carrier) ? carrier : 0, talk));
}

function transcriptOf(x: BolnaExecution): readonly Turn[] | null {
  if (typeof x.transcript !== 'string' || x.transcript.trim() === '') return null;
  const turns: Turn[] = [];
  for (const line of x.transcript.split('\n')) {
    const m = /^\s*(assistant|user)\s*:\s*(.*)$/i.exec(line);
    if (m === null) {
      // A continuation of the previous turn (the text itself had a newline).
      const last = turns[turns.length - 1];
      if (last !== undefined && line.trim() !== '')
        turns[turns.length - 1] = { ...last, text: `${last.text} ${line.trim()}` };
      continue;
    }
    const text = (m[2] ?? '').trim();
    if (text === '') continue;
    // Bolna's transcript carries no timings; order is all we have.
    turns.push({
      role: (m[1] ?? '').toLowerCase() === 'assistant' ? 'agent' : 'customer',
      text,
      startMs: 0,
    });
  }
  return turns.length === 0 ? null : turns;
}

export function resultOf(x: BolnaExecution): EndedResult {
  const cost = x.cost_breakdown?.total_cost_to_deduct ?? x.total_cost;
  const turns = transcriptOf(x);
  return {
    // No word timings: whether the customer spoke at all is what E-25 needs, so a transcript
    // with no customer turn reports 0 and one with any reports "unknown" (null), not a guess.
    humanSpeechSec: turns === null ? 0 : turns.some((t) => t.role === 'customer') ? null : 0,
    recordingUrl: x.telephony_data?.recording_url ?? null,
    transcript: turns,
    extracted: extractedOf(x),
    detectedLocale: null,
    vendorCost:
      typeof cost === 'number' && Number.isFinite(cost)
        ? { minor: Math.round(cost), currency: 'USD' }
        : null,
  };
}

/** Our attempt id, which rides in `user_data` and comes back under `recipient_data`. */
export function attemptIdOf(x: BolnaExecution): string | null {
  const id = x.context_details?.recipient_data?.['naaradh_attempt_id'];
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Maps one webhook delivery. Throws on a body that is not an execution (the route answers
 * 400); returns null for statuses that carry nothing we track.
 */
export function mapWebhook(x: BolnaExecution, vendor: string, now: Date): EngineEvent | null {
  if (typeof x.id !== 'string' || x.id === '' || typeof x.status !== 'string')
    throw new Error('bolna webhook without id/status');
  const base = {
    eventId: `${x.id}:${x.status}`,
    ref: { vendor, callId: x.id },
    sequence: SEQUENCE[x.status] ?? null,
    attemptId: attemptIdOf(x),
  };
  const updated = dateOf(x.updated_at) ?? now;
  if (x.status === 'ringing')
    return { ...base, type: 'call.ringing', at: dateOf(x.initiated_at) ?? updated };
  if (x.status === 'in-progress')
    return { ...base, type: 'call.answered', at: updated, answeredBy: answeredBy(x) };
  if (FAILED_STATUSES.has(x.status))
    return {
      ...base,
      type: 'call.failed',
      at: updated,
      code: x.status.replace('-', '_'),
      // Never the vendor's free text: it can quote the dialled number (invariant 8).
      message: `bolna reported ${x.status}`,
      // A carrier failure is worth another attempt; our own bad request or an empty wallet is
      // not something a re-dial fixes within the retry window.
      retryable: x.status === 'failed',
    };
  if (!ENDED_STATUSES.has(x.status)) return null;
  return {
    ...base,
    type: 'call.ended',
    at: updated,
    reason: endReason(x),
    answeredBy: answeredBy(x),
    durationSec: durationSec(x),
    // Bolna bills conversation seconds; a call nobody answered bills nothing.
    billableSec:
      connected(x) || x.answered_by_voice_mail === true ? (x.conversation_duration ?? 0) : 0,
    ...resultOf(x),
  };
}

export function snapshotOf(
  x: BolnaExecution | null,
  vendor: string,
  callId: string,
): EngineCallSnapshot {
  if (x === null)
    return {
      ref: { vendor, callId },
      status: 'not_found',
      answeredBy: null,
      durationSec: null,
      billableSec: null,
      endReason: null,
      startedAt: null,
      endedAt: null,
      attemptId: null,
      result: null,
    };
  const ended = ENDED_STATUSES.has(x.status);
  const failed = FAILED_STATUSES.has(x.status);
  const done = ended || failed;
  const status: EngineCallSnapshot['status'] = failed
    ? 'failed'
    : ended || x.status === 'call-disconnected'
      ? 'ended'
      : x.status === 'in-progress'
        ? 'in_progress'
        : x.status === 'ringing'
          ? 'ringing'
          : 'queued';
  return {
    ref: { vendor, callId: x.id },
    status,
    answeredBy: done ? answeredBy(x) : null,
    durationSec: done ? durationSec(x) : null,
    billableSec: done ? (connected(x) ? (x.conversation_duration ?? 0) : 0) : null,
    endReason: done ? endReason(x) : null,
    startedAt: dateOf(x.initiated_at) ?? dateOf(x.created_at),
    endedAt: done || status === 'ended' ? dateOf(x.updated_at) : null,
    attemptId: attemptIdOf(x),
    // `call-disconnected` = ended, but Bolna is still writing the result: not final yet.
    result: done ? resultOf(x) : null,
  };
}
