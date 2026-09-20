import { BILLABLE_OUTCOMES, MIN_HUMAN_SPEECH_SEC } from './constants.js';

export type BillableOutcome = (typeof BILLABLE_OUTCOMES)[number];

export type NotBillableReason =
  | 'not_human'
  | 'outcome_not_billable'
  | 'superseded'
  | 'min_human_speech';

export interface BillableInput {
  readonly outcome: string;
  readonly answeredBy: 'human' | 'machine' | 'unknown' | null;
  /** Seconds of detected human speech; null when the engine does not report it. */
  readonly humanSpeechSec: number | null;
  readonly superseded: boolean;
}

export type BillableVerdict =
  | { billable: true; reason: 'ok' }
  | { billable: false; reason: NotBillableReason };

/**
 * Invariant 11 / E-60, as one function. The database trigger `call_outcomes_billable_guard`
 * re-checks the outcome set; this is where answered_by, E-25 and E-40 are applied.
 *
 * Order matters for the reason recorded: supersession (E-40) beats everything, because an
 * order cancelled before the call is never the merchant's cost regardless of what was said.
 */
export function isBillable(input: BillableInput): BillableVerdict {
  if (input.superseded) return { billable: false, reason: 'superseded' };
  if (input.answeredBy !== 'human') return { billable: false, reason: 'not_human' };
  if (!(BILLABLE_OUTCOMES as readonly string[]).includes(input.outcome)) {
    return { billable: false, reason: 'outcome_not_billable' };
  }
  if (input.humanSpeechSec !== null && input.humanSpeechSec < MIN_HUMAN_SPEECH_SEC) {
    return { billable: false, reason: 'min_human_speech' };
  }
  return { billable: true, reason: 'ok' };
}
