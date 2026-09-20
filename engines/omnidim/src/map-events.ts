import type {
  AnsweredBy,
  EndedResult,
  EndReason,
  EngineCallSnapshot,
  EngineEvent,
  Turn,
} from '@naaradh/engines-core';
import type { OmniCallLog, OmniWebhook } from './wire.js';

/**
 * OmniDimension reports a call once: the post-call webhook, unsigned. There is no ringing or
 * answered event (`progressEvents: false`), so an attempt goes from DIALING straight to its
 * terminal state, and — because nothing is signed — the outcome is written from the call log
 * fetched back from the API, never from the webhook body (invariant 9, E-23).
 *
 * Both shapes (webhook, call log) reduce to one `Normal` record so they map identically.
 */

interface Normal {
  readonly status: string;
  readonly durationSec: number;
  readonly voicemail: boolean;
  readonly hangupSource: string;
  readonly recordingUrl: string | null;
  readonly conversation: string | null;
  readonly extracted: Readonly<Record<string, unknown>> | null;
  readonly cost: number | null;
}

/** Outcomes the agent records that are also end reasons (the guardrails end the call on them). */
const OUTCOME_REASON: Readonly<Record<string, EndReason>> = {
  opt_out: 'opt_out',
  wrong_number: 'wrong_number',
  minor_answered: 'minor_answered',
  recording_refused: 'recording_refused',
};

const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Extracted variables arrive as text ("Not provided" when the model found nothing). Typed keys
 * are named `field__i|f|b` by the adapter (extractionVariables) and restored here.
 */
export function extractedOf(
  raw: Readonly<Record<string, unknown>> | false | null | undefined,
): Readonly<Record<string, unknown>> | null {
  if (raw === null || raw === undefined || raw === false) return null;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    const typed = /^(.*)__([ifb])$/.exec(name);
    const key = typed?.[1] ?? name;
    const missing = value === null || value === false || value === '' || value === 'Not provided';
    if (typed === null) {
      if (!missing) out[key] = typeof value === 'string' ? value.trim() : value;
      continue;
    }
    if (missing) continue;
    if (typed[2] === 'b') out[key] = /^(true|yes)$/i.test(text(value).trim());
    else {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = typed[2] === 'i' ? Math.trunc(n) : n;
    }
  }
  return 'outcome' in out ? out : null;
}

function connected(n: Normal): boolean {
  return n.status === 'completed' && n.durationSec > 0;
}

function answeredBy(n: Normal): AnsweredBy {
  if (n.voicemail) return 'machine';
  return connected(n) ? 'human' : 'unknown';
}

function endReason(n: Normal): EndReason {
  const status = n.status.replace(/-/g, '_');
  if (n.voicemail || status === 'voicemail_detected') return 'amd_hangup';
  if (status === 'no_answer') return 'no_answer';
  if (status === 'busy') return 'busy';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'failed') return 'carrier_temp_fail';
  if (status !== 'completed') return 'engine_error';
  if (!connected(n)) return 'no_answer';
  const outcome = n.extracted?.['outcome'];
  if (typeof outcome === 'string' && OUTCOME_REASON[outcome] !== undefined)
    return OUTCOME_REASON[outcome];
  if (/user|customer|callee/i.test(n.hangupSource)) return 'customer_hangup'; // [VERIFY] values
  return 'completed';
}

function transcriptOf(conversation: string | null): readonly Turn[] | null {
  if (conversation === null) return null;
  const turns: Turn[] = [];
  for (const line of conversation.split(/<br\s*\/?>|\n/)) {
    const m = /^\s*(user|LLM|assistant|bot)\s*:\s*(.*)$/i.exec(line);
    const text = (m?.[2] ?? '').trim();
    if (m === null || text === '') continue;
    turns.push({
      role: (m[1] ?? '').toLowerCase() === 'user' ? 'customer' : 'agent',
      text,
      startMs: 0,
    });
  }
  return turns.length === 0 ? null : turns;
}

function resultOf(n: Normal): EndedResult {
  const turns = transcriptOf(n.conversation);
  return {
    // No timings: a transcript with no customer turn is zero speech (E-25); otherwise unknown.
    humanSpeechSec: turns === null ? 0 : turns.some((t) => t.role === 'customer') ? null : 0,
    recordingUrl: n.recordingUrl,
    transcript: turns,
    extracted: n.extracted,
    detectedLocale: null,
    // [VERIFY] dollars, as a decimal.
    vendorCost: n.cost === null ? null : { minor: Math.round(n.cost * 100), currency: 'USD' },
  };
}

const ofWebhook = (w: OmniWebhook): Normal => ({
  status: (w.call_status ?? '').toLowerCase(),
  durationSec: Math.max(0, Math.round(Number(w.call_duration ?? 0)) || 0),
  voicemail: w.is_voicemail === true,
  hangupSource: str(w.hangup_source) ?? '',
  recordingUrl: str(w.recording_url),
  conversation: str(w.call_report?.full_conversation),
  extracted: extractedOf(w.call_report?.extracted_variables),
  cost: null,
});

const ofLog = (l: OmniCallLog): Normal => ({
  status: (l.call_status ?? '').toLowerCase(),
  durationSec: Math.max(0, Math.round(l.call_duration_in_seconds ?? 0)),
  voicemail: l.is_voicemail === true || l.amd_detected === true,
  hangupSource: str(l.hangup_source) ?? '',
  recordingUrl: str(l.recording_url),
  conversation: str(l.call_conversation),
  extracted: extractedOf(l.extracted_variables),
  cost: typeof l.call_cost === 'number' && Number.isFinite(l.call_cost) ? l.call_cost : null,
});

/** `2026-05-04 14:46:15` — zone unstated; read as UTC. [VERIFY] */
function dateOf(v: string | null | undefined): Date | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(`${v.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : new Date(t);
}

export function requestIdOf(v: OmniCallLog['call_request_id']): string | null {
  const id = v !== null && typeof v === 'object' ? v.id : v;
  return typeof id === 'number' ? String(id) : null;
}

/** Maps the post-call webhook. Throws when it names no call (the route answers 400). */
export function mapWebhook(w: OmniWebhook, vendor: string, now: Date): EngineEvent {
  const requestId = requestIdOf(w.call_request_id ?? null);
  const meta = w.metadata ?? {};
  const attemptId =
    typeof meta['naaradh_attempt_id'] === 'string' ? meta['naaradh_attempt_id'] : null;
  if (requestId === null && attemptId === null)
    throw new Error('omnidim webhook without call_request_id or our attempt id');
  const n = ofWebhook(w);
  const base = {
    eventId: `${requestId ?? attemptId ?? ''}:${String(w.call_id ?? '')}:${n.status}`,
    ref: { vendor, callId: requestId ?? '' },
    at: dateOf(w.end_time) ?? now,
    sequence: 1,
    attemptId,
  };
  if (n.status === 'failed')
    return {
      ...base,
      type: 'call.failed',
      code: 'failed',
      message: 'omnidim reported failed',
      retryable: true,
    };
  return {
    ...base,
    type: 'call.ended',
    reason: endReason(n),
    answeredBy: answeredBy(n),
    durationSec: n.durationSec,
    // [VERIFY] from an invoice: OmniDimension bills connected time.
    billableSec: connected(n) || n.voicemail ? n.durationSec : 0,
    ...resultOf(n),
  };
}

export function snapshotOf(
  log: OmniCallLog | null,
  vendor: string,
  callId: string,
): EngineCallSnapshot {
  if (log === null)
    return {
      ref: { vendor, callId },
      status: 'not_found',
      answeredBy: null,
      durationSec: null,
      billableSec: null,
      endReason: null,
      startedAt: null,
      endedAt: null,
      result: null,
    };
  const n = ofLog(log);
  // A call log exists only once the call is over.
  return {
    ref: { vendor, callId },
    status: n.status === 'failed' ? 'failed' : 'ended',
    answeredBy: answeredBy(n),
    durationSec: n.durationSec,
    billableSec: connected(n) || n.voicemail ? n.durationSec : 0,
    endReason: endReason(n),
    startedAt: null,
    endedAt: null,
    // The log does not echo our metadata, so it cannot name the attempt (the webhook does).
    attemptId: null,
    result: resultOf(n),
  };
}
