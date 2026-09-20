import { describe, expect, it } from 'vitest';
import * as C from '../../src/constants.js';

/**
 * The compliance regression suite (`pnpm test:compliance`) — a hard gate before any merge.
 *
 * This first file pins the regulatory constants themselves. It looks tautological, and it is
 * deliberately so: these numbers are the difference between a compliant platform and a
 * ₹10 lakh penalty plus a one-year blacklist of every telecom resource. Pinning them means
 * that changing one cannot happen by accident, in passing, while fixing something else —
 * it has to be done on purpose, with an ADR, by editing this file too.
 *
 * If a test here fails: do not update the expectation to match the code. Either the code is
 * wrong, or a rule genuinely changed and needs a decision record in docs/decisions/
 * (CLAUDE.md: "Never weaken a gate to make a test pass").
 */
describe('India calling window (invariant 3)', () => {
  it('is 09:00-21:00 in Asia/Kolkata', () => {
    expect(C.WINDOW_IN.open).toBe('09:00');
    expect(C.WINDOW_IN.close).toBe('21:00');
    expect(C.WINDOW_IN.zone).toBe('Asia/Kolkata');
  });

  it('stops dialling before the window closes rather than exactly on it', () => {
    // E-01: an order at 20:50 must be dialled by 20:55 or gated. A call started at 20:59
    // would still be talking at 21:00.
    expect(C.WINDOW_CLOSE_BUFFER_MINUTES).toBeGreaterThan(0);
  });
});

describe('transactional window (invariant 4)', () => {
  it('is 30 minutes from the customer-triggered event', () => {
    expect(C.TRANSACTIONAL_WINDOW_MINUTES).toBe(30);
  });

  it('bounds cod_confirm exactly by that window', () => {
    // The COD envelope may never be widened "to fit a retry in" (AGENTS.md section 5.5).
    expect(C.USE_CASE_WINDOWS.cod_confirm.notAfterMinutes).toBe(C.TRANSACTIONAL_WINDOW_MINUTES);
    expect(C.USE_CASE_WINDOWS.cod_confirm.purpose).toBe('transactional');
  });
});

describe('consent and suppression', () => {
  it('expires explicit promotional consent after 7 days in India', () => {
    expect(C.PROMOTIONAL_CONSENT_VALIDITY_DAYS_IN).toBe(7);
  });

  it('holds an opt-out for 90 days', () => {
    expect(C.OPT_OUT_COOLING_DAYS).toBe(90);
  });

  it('treats every promotional use case as consent-requiring (invariant 5)', () => {
    expect([...C.PROMOTIONAL_USE_CASES]).toEqual(['abandoned_cart', 'feedback', 'reactivation']);
    expect(C.USE_CASE_WINDOWS.abandoned_cart.purpose).toBe('promotional');
  });

  it('scrubs DND on transactional calls until Q-02 is answered in writing', () => {
    // Fail-closed default. Flipping this needs a TSP letter on file, not an opinion.
    expect(C.DND_SCRUB_TRANSACTIONAL_DEFAULT).toBe(true);
  });
});

describe('complaint thresholds (E-05)', () => {
  it('pauses a tenant at 3 and trips the global kill switch at 5 in a 10-day window', () => {
    // The regulatory trigger is 5 valid complaints in a rolling 10 days. SPEC v1.0 section
    // 4.1.1 said "kill at 4" while E-05 said 5; corrected to 5 in SPEC v1.1.
    expect(C.COMPLAINT_WINDOW_DAYS).toBe(10);
    expect(C.COMPLAINT_TENANT_PAUSE_THRESHOLD).toBe(3);
    expect(C.COMPLAINT_GLOBAL_KILL_THRESHOLD).toBe(5);
  });

  it('pauses a single tenant before the global threshold is reachable', () => {
    expect(C.COMPLAINT_TENANT_PAUSE_THRESHOLD).toBeLessThan(C.COMPLAINT_GLOBAL_KILL_THRESHOLD);
  });
});

describe('attempt limits', () => {
  it('allows 2 attempts per 24h, 3 lifetime, 2h apart for service/promotional', () => {
    expect(C.MAX_ATTEMPTS_PER_24H).toBe(2);
    expect(C.MAX_ATTEMPTS_LIFETIME).toBe(3);
    expect(C.MIN_HOURS_BETWEEN_ATTEMPTS).toBe(2);
    expect(C.MIN_MINUTES_BETWEEN_ATTEMPTS.service).toBe(120);
    expect(C.MIN_MINUTES_BETWEEN_ATTEMPTS.promotional).toBe(120);
  });

  it('keeps the transactional gap short enough for one retry inside the 30-minute envelope', () => {
    // DECISION recorded in constants.ts: 10 minutes. Must be > 0 (never a redial storm) and
    // must leave room for a second attempt: gap + not_before (2m) + a call must fit in 30m.
    expect(C.MIN_MINUTES_BETWEEN_ATTEMPTS.transactional).toBe(10);
    expect(C.MIN_MINUTES_BETWEEN_ATTEMPTS.transactional).toBeLessThan(
      C.TRANSACTIONAL_WINDOW_MINUTES / 2,
    );
  });

  it("caps every use case's call duration", () => {
    for (const [useCase, sec] of Object.entries(C.MAX_DURATION_SEC_BY_USE_CASE)) {
      expect(sec, useCase).toBeGreaterThan(0);
    }
    expect(C.MAX_DURATION_SEC_BY_USE_CASE.cod_confirm).toBe(120);
    expect(C.MAX_DURATION_SEC_BY_USE_CASE.abandoned_cart).toBe(150);
    expect(C.MAX_DURATION_SEC_BY_USE_CASE.appointment_confirm).toBe(240);
    expect(C.MAX_DURATION_SEC_BY_USE_CASE.lead_callback).toBe(180);
  });

  it('cannot exceed the lifetime cap within a single day', () => {
    expect(C.MAX_ATTEMPTS_PER_24H).toBeLessThanOrEqual(C.MAX_ATTEMPTS_LIFETIME);
  });
});

describe('billable outcomes (invariant 11 / E-60)', () => {
  it('is exactly the five agreed outcomes', () => {
    // Fixed by the Terms. Adding or removing one changes what merchants are charged for and
    // requires a product decision in docs/decisions/.
    expect([...C.BILLABLE_OUTCOMES]).toEqual([
      'confirmed',
      'confirmed_with_changes',
      'cancelled',
      'rescheduled',
      'booked',
    ]);
  });

  it('never bills a non-answer or an indefinite result', () => {
    const neverBillable = [
      'no_answer',
      'busy',
      'voicemail',
      'wrong_number',
      'opt_out',
      'inconclusive',
      'failed',
      'transferred',
      'outcome_superseded',
      'minor_answered',
      'recording_refused',
      'no_response',
    ];
    for (const outcome of neverBillable) {
      expect(C.BILLABLE_OUTCOMES as readonly string[], outcome).not.toContain(outcome);
    }
  });

  it('requires real human speech before an outcome can be billed (E-25)', () => {
    expect(C.MIN_HUMAN_SPEECH_SEC).toBeGreaterThanOrEqual(5);
  });
});

describe('write-back safety (invariant 14 / E-44)', () => {
  it('requires high confidence before auto-cancelling or writing an address', () => {
    expect(C.AUTO_WRITE_CONFIDENCE_MIN).toBe(0.9);
  });
});

describe('operational safety', () => {
  it('caches kill switches briefly enough to stop dispatch quickly (invariant 12)', () => {
    expect(C.KILL_SWITCH_CACHE_TTL_SEC).toBeLessThanOrEqual(5);
  });

  it('stops dispatch within 60s of an uninstall (E-48)', () => {
    expect(C.UNINSTALL_STOP_DISPATCH_SECONDS).toBeLessThanOrEqual(60);
  });

  it('persists recordings to our own bucket before vendor URLs expire (E-34)', () => {
    expect(C.RECORDING_PERSIST_DEADLINE_MINUTES).toBeLessThanOrEqual(10);
  });

  it('keeps every use case inside a bounded call duration (E-32)', () => {
    for (const [useCase, window] of Object.entries(C.USE_CASE_WINDOWS)) {
      expect(window.maxDurationSec, useCase).toBeGreaterThan(0);
      expect(window.maxDurationSec, useCase).toBeLessThanOrEqual(240);
    }
  });
});

describe('retention (TODO_LEGAL, Q-06)', () => {
  it('defaults recordings to 90 days within a 30-365 day range', () => {
    expect(C.RETENTION_RECORDINGS_DAYS_DEFAULT).toBe(90);
    expect(C.RETENTION_RECORDINGS_DAYS_MIN).toBe(30);
    expect(C.RETENTION_RECORDINGS_DAYS_MAX).toBe(365);
    expect(C.RETENTION_RECORDINGS_DAYS_DEFAULT).toBeGreaterThanOrEqual(
      C.RETENTION_RECORDINGS_DAYS_MIN,
    );
    expect(C.RETENTION_RECORDINGS_DAYS_DEFAULT).toBeLessThanOrEqual(
      C.RETENTION_RECORDINGS_DAYS_MAX,
    );
  });

  it('keeps legal records far longer than call content', () => {
    // Consents, suppressions, audit log and billing ledger outlive the recording they
    // relate to: they are the proof of why a call was allowed.
    expect(C.RETENTION_LEGAL_RECORDS_DAYS).toBeGreaterThan(C.RETENTION_RECORDINGS_DAYS_MAX);
  });
});
