import { addMinutes } from '@naaradh/shared';
import { MIN_MINUTES_BETWEEN_ATTEMPTS, WINDOW_CLOSE_BUFFER_MINUTES } from './constants.js';
import type { Purpose } from './gate/types.js';
import { isOpen, nextOpen, type RecipientWindow } from './gate/windows.js';

/**
 * Retry policy (AGENTS §5.5). Which terminal reasons may be retried, and when.
 */

export const RETRY_ELIGIBLE = new Set([
  'no_answer',
  'busy',
  'amd_hangup',
  'inconclusive',
  'carrier_temp_fail',
  'no_response',
]);

export const NEVER_RETRY = new Set([
  'wrong_number',
  'opt_out',
  'recording_refused',
  'minor_answered',
  'invalid_number',
  'outcome_superseded',
  // every billable outcome is final
  'confirmed',
  'confirmed_with_changes',
  'cancelled',
  'rescheduled',
  'booked',
]);

export function isRetryEligible(endReasonOrOutcome: string): boolean {
  if (NEVER_RETRY.has(endReasonOrOutcome)) return false;
  return RETRY_ELIGIBLE.has(endReasonOrOutcome);
}

export interface NextRetryInput {
  readonly now: Date;
  readonly purpose: Purpose;
  readonly notAfter: Date;
  readonly window: RecipientWindow;
}

/**
 * When to try again, or null → EXHAUSTED.
 *
 *   candidate = now + minimum gap for the purpose
 *   if the window is closed at the candidate:
 *       transactional → null (never re-queued to the next morning — invariant 4)
 *       otherwise     → next opening
 *   if candidate > not_after → null
 *
 * The COD envelope is 30 minutes and the transactional gap is short precisely so that a
 * no-answer at minute 3 can be retried at minute 13 inside the same window. The window is
 * never widened to fit a retry in.
 */
export function nextRetryAt(input: NextRetryInput): Date | null {
  let candidate = addMinutes(input.now, MIN_MINUTES_BETWEEN_ATTEMPTS[input.purpose]);
  if (!isOpen(candidate, input.window, WINDOW_CLOSE_BUFFER_MINUTES)) {
    if (input.purpose === 'transactional') return null;
    candidate = nextOpen(candidate, input.window, WINDOW_CLOSE_BUFFER_MINUTES);
  }
  if (candidate > input.notAfter) return null;
  return candidate;
}
