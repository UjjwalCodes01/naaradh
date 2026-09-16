import { describe, expect, it } from 'vitest';
import { schema } from '@naaradh/db';
import { NEVER_RETRY, RETRY_ELIGIBLE } from '@naaradh/compliance';
import { EXTRACTION_SCHEMAS } from '@naaradh/scripts';
import {
  WRITEBACK_USE_CASES,
  appointmentStatusAfterCall,
  scrubExtracted,
} from '../../src/results/finalize.js';

/**
 * An extraction outcome the database cannot store becomes `inconclusive` and a RETRY — which
 * for a promotional call means a second call nobody wanted. Every outcome any schema can
 * produce must exist in the outcome enum (this caught abandoned-cart and lead-callback
 * outcomes that were silently discarded before ADR-0010).
 */
describe('extraction outcomes', () => {
  const all = Object.entries(EXTRACTION_SCHEMAS).flatMap(([name, s]) =>
    (s.shape.outcome.options as readonly string[]).map((o) => [name, o] as const),
  );

  it('every outcome an extraction schema can return is storable', () => {
    for (const [name, o] of all)
      expect(schema.outcome.enumValues as readonly string[], `${name}: ${o}`).toContain(o);
  });

  it('a customer who answered is never called again about it', () => {
    for (const o of [
      'will_complete',
      'will_buy_later',
      'not_interested',
      'price_objection',
      'feedback_given',
      'qualified',
    ]) {
      expect(NEVER_RETRY.has(o)).toBe(true);
      expect(RETRY_ELIGIBLE.has(o)).toBe(false);
    }
  });
});

describe('results side effects', () => {
  it('only order use cases write back to the store', () => {
    expect([...WRITEBACK_USE_CASES].sort()).toEqual(['cod_confirm', 'delivery_reschedule']);
    for (const u of ['abandoned_cart', 'feedback', 'lead_callback', 'reactivation'])
      expect(WRITEBACK_USE_CASES.has(u)).toBe(false);
  });

  it('free text from the customer never goes out in a webhook', () => {
    expect(
      scrubExtracted({ outcome: 'feedback_given', nps: 7, comment: 'the box was torn' }),
    ).toEqual({
      outcome: 'feedback_given',
      nps: 7,
      comment: '[in dashboard]',
    });
  });
});

describe('an appointment call changes the appointment (ADR-0011 §7)', () => {
  it('confirmed and cancelled are taken at face value', () => {
    expect(appointmentStatusAfterCall('confirmed', false)).toBe('confirmed');
    expect(appointmentStatusAfterCall('cancelled', false)).toBe('cancelled');
  });

  it('a reschedule gives up the old slot only when a new one was actually booked', () => {
    // With a replacement the old slot must be released, or the merchant's diary shows the
    // customer twice; the `cancelled` status is what tells the provider.
    expect(appointmentStatusAfterCall('rescheduled', true)).toBe('cancelled');
    // Without one, releasing it would leave the customer with no appointment at all.
    expect(appointmentStatusAfterCall('rescheduled', false)).toBe('rescheduled');
  });

  it('every other outcome leaves the appointment alone', () => {
    for (const o of ['no_answer', 'voicemail', 'inconclusive', 'transferred', 'opt_out', 'booked'])
      expect(appointmentStatusAfterCall(o, true)).toBeNull();
  });
});
