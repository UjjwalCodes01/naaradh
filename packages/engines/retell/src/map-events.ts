import type {
  AnsweredBy,
  EndReason,
  EngineCallSnapshot,
  EngineEvent,
  Turn,
} from '@naaradh/engines-core';
import type { RetellCall, RetellUtterance, RetellWebhook } from './wire.js';

/**
 * Retell's three webhooks → our normalised events (P6-ENG-1).
 *
 *   call_started   → call.ringing                     the call exists and is being placed
 *   call_ended     → call.answered (connected calls)  carries the real connect time and the
 *                                                     machine/human verdict, but NOT the result
 *                  → call.ended   (never connected)  no answer, busy, failed: nothing to analyse
 *   call_analyzed  → call.ended                        the full call plus the extracted result
 *
 * Why the terminal event is `call_analyzed`: the extracted outcome (confirmed, cancelled…)
 * arrives only with the analysis, and the outcome decides billing (invariant 11). Finalising
 * on `call_ended` would bill nothing and never look again. A call whose analysis never arrives
 * is found by reconcile (E-21) and closed inconclusive — unbilled, which is the safe side.
 *
 * Retell does not report the disclosure separately (`reportsDisclosure: false`): the opening
 * line IS the disclosure, and the results-consumer stamps it at the connect time.
 *
 * `sequence` is the event's position in Retell's fixed order, so the results-consumer can see
 * an out-of-order delivery for what it is.
 */

const SEQUENCE: Readonly<Record<string, number>> = {
  call_started: 1,
  call_ended: 2,
  call_analyzed: 3,
};

/** Retell disconnection reasons for calls that never reached a person or a machine. [VERIFY] */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  'dial_no_answer',
  'dial_busy',
  'dial_failed',
  'invalid_destination',
  'user_declined',
  'telephony_provider_permission_denied',
  'telephony_provider_unavailable',
  'sip_routing_error',
  'marked_as_spam',
  'scam_detected',
  'no_valid_payment',
  'concurrency_limit_reached',
  'registered_call_timeout',
  'error_user_not_joined',
]);

const REASON: Readonly<Record<string, EndReason>> = {
  agent_hangup: 'completed',
  user_hangup: 'customer_hangup',
  inactivity: 'completed',
  call_transfer: 'transfer_completed',
  voicemail_reached: 'amd_hangup',
  machine_detected: 'amd_hangup',
  max_duration_reached: 'max_duration',
  dial_no_answer: 'no_answer',
  dial_busy: 'busy',
  user_declined: 'busy',
  dial_failed: 'carrier_temp_fail',
  telephony_provider_unavailable: 'carrier_temp_fail',
  telephony_provider_permission_denied: 'carrier_temp_fail',
  sip_routing_error: 'carrier_temp_fail',
  invalid_destination: 'invalid_number',
};

/** Outcomes the agent records that are also end reasons (the guardrails end the call on them). */
const OUTCOME_REASON: Readonly<Record<string, EndReason>> = {
  opt_out: 'opt_out',
  wrong_number: 'wrong_number',
  minor_answered: 'minor_answered',
  recording_refused: 'recording_refused',
};

export function connected(call: RetellCall): boolean {
  const reason = call.disconnection_reason ?? '';
  if (NEVER_CONNECTED.has(reason)) return false;
  if (reason.startsWith('error_')) return (call.duration_ms ?? 0) > 0;
  return call.start_timestamp !== null && call.start_timestamp !== undefined;
}

export function answeredBy(call: RetellCall): AnsweredBy {
  if (!connected(call)) return 'unknown';
  const reason = call.disconnection_reason ?? '';
  if (
    call.call_analysis?.in_voicemail === true ||
    reason === 'voicemail_reached' ||
    reason === 'machine_detected'
  )
    return 'machine';
  return 'human';
}

export function endReason(call: RetellCall): EndReason {
  const outcome = call.call_analysis?.custom_analysis_data?.['outcome'];
  if (typeof outcome === 'string' && OUTCOME_REASON[outcome] !== undefined && connected(call))
    return OUTCOME_REASON[outcome];
  const reason = call.disconnection_reason ?? '';
  // Anything else — Retell's own error_* reasons, spam labelling — is the engine failing us.
  return REASON[reason] ?? 'engine_error';
}

function seconds(call: RetellCall): number {
  if (typeof call.duration_ms === 'number') return Math.round(call.duration_ms / 1000);
  if (typeof call.start_timestamp === 'number' && typeof call.end_timestamp === 'number')
    return Math.max(0, Math.round((call.end_timestamp - call.start_timestamp) / 1000));
  return 0;
}

/** Seconds the customer was actually speaking (E-25: a pocket answer is not billable). */
/** The transcript, when Retell sent one as a list (a malformed field is treated as none). */
function utterances(call: RetellCall): readonly RetellUtterance[] | null {
  const t: unknown = call.transcript_object;
  return Array.isArray(t) ? (t as readonly RetellUtterance[]) : null;
}

function humanSpeechSec(call: RetellCall): number | null {
  const turns = utterances(call);
  if (turns === null) return null;
  let total = 0;
  for (const u of turns) {
    if (u.role !== 'user') continue;
    for (const w of u.words ?? []) total += Math.max(0, w.end - w.start);
  }
  return Math.round(total * 10) / 10;
}

function transcript(call: RetellCall): readonly Turn[] | null {
  const turns = utterances(call);
  if (turns === null) return null;
  return turns.map((u) => ({
    role: u.role === 'agent' ? ('agent' as const) : ('customer' as const),
    text: u.content,
    startMs: Math.round((u.words?.[0]?.start ?? 0) * 1000),
  }));
}

function attemptIdOf(call: RetellCall): string | null {
  const id = call.metadata?.['call_id'];
  return typeof id === 'string' ? id : null;
}

function ended(body: RetellWebhook, vendor: string, at: Date): EngineEvent {
  const call = body.call;
  const connectedCall = connected(call);
  const cost = call.call_cost?.combined_cost;
  return {
    type: 'call.ended',
    eventId: `${call.call_id}:${body.event}`,
    ref: { vendor, callId: call.call_id },
    at,
    sequence: SEQUENCE[body.event] ?? null,
    attemptId: attemptIdOf(call),
    reason: endReason(call),
    answeredBy: answeredBy(call),
    durationSec: seconds(call),
    billableSec: connectedCall
      ? (call.call_cost?.total_duration_seconds ?? Math.ceil((call.duration_ms ?? 0) / 1000))
      : 0,
    humanSpeechSec: humanSpeechSec(call),
    recordingUrl: call.recording_url ?? null,
    transcript: transcript(call),
    extracted: call.call_analysis?.custom_analysis_data ?? null,
    detectedLocale: null,
    vendorCost:
      typeof cost === 'number' && Number.isFinite(cost)
        ? { minor: Math.round(cost), currency: 'USD' }
        : null,
  };
}

/** Maps a VERIFIED webhook body. Throws on a shape we do not understand (the route answers 400). */
export function mapWebhook(body: RetellWebhook, vendor: string, now: Date): EngineEvent {
  const call = body.call;
  if (typeof call.call_id !== 'string' || call.call_id === '')
    throw new Error('retell webhook without call.call_id');
  const base = {
    eventId: `${call.call_id}:${body.event}`,
    ref: { vendor, callId: call.call_id },
    sequence: SEQUENCE[body.event] ?? null,
    attemptId: attemptIdOf(call),
  };
  const startedAt = typeof call.start_timestamp === 'number' ? new Date(call.start_timestamp) : now;
  const endedAt = typeof call.end_timestamp === 'number' ? new Date(call.end_timestamp) : now;

  switch (body.event) {
    case 'call_started':
      return { ...base, type: 'call.ringing', at: startedAt };
    case 'call_ended':
      return connected(call)
        ? { ...base, type: 'call.answered', at: startedAt, answeredBy: answeredBy(call) }
        : ended(body, vendor, endedAt);
    case 'call_analyzed':
      return ended(body, vendor, endedAt);
    default:
      throw new Error(`retell webhook event ${body.event} is not handled`);
  }
}

export function snapshotOf(
  call: RetellCall | null,
  vendor: string,
  callId: string,
): EngineCallSnapshot {
  if (call === null)
    return {
      ref: { vendor, callId },
      status: 'not_found',
      answeredBy: null,
      durationSec: null,
      billableSec: null,
      endReason: null,
      startedAt: null,
      endedAt: null,
    };
  const status =
    call.call_status === 'registered'
      ? 'queued'
      : call.call_status === 'ongoing'
        ? 'in_progress'
        : call.call_status === 'error'
          ? 'failed'
          : 'ended';
  const done = status === 'ended' || status === 'failed';
  return {
    ref: { vendor, callId: call.call_id },
    status,
    answeredBy: done ? answeredBy(call) : null,
    durationSec: done ? seconds(call) : null,
    billableSec: done ? (call.call_cost?.total_duration_seconds ?? null) : null,
    endReason: done ? endReason(call) : null,
    startedAt: typeof call.start_timestamp === 'number' ? new Date(call.start_timestamp) : null,
    endedAt: typeof call.end_timestamp === 'number' ? new Date(call.end_timestamp) : null,
  };
}
