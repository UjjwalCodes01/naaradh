import { describe, expect, it } from 'vitest';
import { DISCLOSURES, RECORDING_CONSENT_QUESTIONS } from '../src/disclosures.js';
import { renderScript } from '../src/render.js';
import { ABANDONED_CART_DE_DE, ABANDONED_CART_EN_US, COD_CONFIRM_EN_IN } from '../src/templates.js';

/**
 * P6-CMP-1 — where every party must agree to a recording, the opening ASKS and nothing about
 * the customer is said until they say yes. The question is appended at render time from the
 * recipient's region, never stored in a merchant's script.
 */

const slots = {
  brand: 'Client A',
  customer_name: 'Test',
  cart_summary: 'two items',
  order_ref: '1001',
  amount: '499',
  item_summary: 'a kurta',
};

describe('recording consent at render time', () => {
  it('notice (the default) is exactly what it was: disclosure, then the purpose', () => {
    const r = renderScript(COD_CONFIRM_EN_IN, slots);
    expect(r.firstUtterance).toContain('1001');
    expect(r.systemPrompt).not.toContain('recording_refused. Do not mention');
  });

  it('ask: the opening ends with the question, and the order is not mentioned yet', () => {
    const r = renderScript(ABANDONED_CART_EN_US, slots, { recordingConsent: 'ask' });
    expect(r.firstUtterance.endsWith(RECORDING_CONSENT_QUESTIONS['en-US'] ?? '?')).toBe(true);
    expect(r.firstUtterance).not.toContain('two items');
    // The disclosure is still the first thing said (invariant 7).
    const opening = r.firstUtterance.toLowerCase();
    expect(DISCLOSURES['en-US']?.ai.some((p) => opening.includes(p))).toBe(true);
    expect(DISCLOSURES['en-US']?.recording.some((p) => opening.includes(p))).toBe(true);
  });

  it('ask: the prompt makes a clear yes the condition, and a refusal ends the call', () => {
    const r = renderScript(ABANDONED_CART_EN_US, slots, { recordingConsent: 'ask' });
    expect(r.systemPrompt).toContain('Continue only after a clear yes');
    expect(r.systemPrompt).toContain('record recording_refused');
    // The purpose line moves into the prompt, with its slots described by name, not value.
    expect(r.systemPrompt).toContain('Once they agree, say:');
    expect(r.systemPrompt).not.toContain('two items');
  });

  it('the cached agent’s template keeps its slots in either mode', () => {
    const notice = renderScript(ABANDONED_CART_EN_US, slots);
    const ask = renderScript(ABANDONED_CART_EN_US, slots, { recordingConsent: 'ask' });
    expect(notice.firstUtteranceTemplate).toContain('{{');
    expect(notice.firstUtteranceTemplate).not.toContain('Test');
    expect(ask.firstUtteranceTemplate).not.toContain('Test');
    expect(ask.firstUtteranceTemplate).toContain(RECORDING_CONSENT_QUESTIONS['en-US']);
  });

  it('German asks in German', () => {
    const r = renderScript(ABANDONED_CART_DE_DE, slots, { recordingConsent: 'ask' });
    expect(r.firstUtterance).toContain('aufgezeichnet wird?');
  });

  it('every locale with disclosures has a consent question', () => {
    for (const locale of Object.keys(DISCLOSURES))
      expect(RECORDING_CONSENT_QUESTIONS[locale], locale).toBeTruthy();
  });
});
