import { describe, expect, it } from 'vitest';
import { EXTRACTION_SCHEMAS, parseExtraction } from '../src/extraction.js';
import {
  ABANDONED_CART_EN_IN,
  ABANDONED_CART_HI_IN,
  DEFAULT_TEMPLATES,
  FEEDBACK_EN_IN,
  FEEDBACK_HI_IN,
} from '../src/templates.js';
import { validateScript } from '../src/validate.js';
import { VARIABLES_ALLOWED, variableRefs } from '../src/template.js';

/** ADR-0010: abandoned-cart and feedback scripts and what their calls may record. */

const outcomesOf = (name: string): readonly string[] => {
  const schema = (
    EXTRACTION_SCHEMAS as Record<string, { shape: { outcome: { options: string[] } } }>
  )[name];
  if (schema === undefined) throw new Error(`no schema ${name}`);
  return schema.shape.outcome.options;
};

describe('promotional templates', () => {
  const promotional = [ABANDONED_CART_HI_IN, ABANDONED_CART_EN_IN, FEEDBACK_HI_IN, FEEDBACK_EN_IN];

  it('validate, carry an opt-out line and are shipped by default', () => {
    for (const t of promotional) {
      expect(validateScript(t), `${t.use_case}/${t.locale}`).toMatchObject({ ok: true });
      expect(t.opt_out_line).toBeTruthy();
      expect(DEFAULT_TEMPLATES).toContain(t);
    }
  });

  it('a promotional script without an opt-out line fails validation', () => {
    const { opt_out_line: _drop, ...rest } = FEEDBACK_EN_IN;
    const r = validateScript(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('opt_out_line_missing');
  });

  it('every branch outcome is one the extraction schema can record', () => {
    for (const t of DEFAULT_TEMPLATES) {
      if (t.use_case === 'inbound_support') continue;
      const allowed = outcomesOf(t.extraction);
      for (const b of t.branches)
        if (b.outcome !== undefined)
          expect(allowed, `${t.use_case}/${t.locale} branch ${b.intent}`).toContain(b.outcome);
    }
  });

  it('only references variables allowed for the use case (E-72)', () => {
    for (const t of promotional) {
      const text = [t.opening, t.purpose_line, t.closing, ...t.branches.map((b) => b.say)].join(
        ' ',
      );
      for (const v of variableRefs(text)) expect(VARIABLES_ALLOWED[t.use_case]).toContain(v);
    }
  });

  it('never promises a link or a discount (Naaradh sends no messages, ADR-0010 §10)', () => {
    for (const t of promotional) {
      const said = [t.purpose_line, ...t.branches.map((b) => b.say), t.closing]
        .join(' ')
        .toLowerCase();
      expect(said).not.toMatch(/bhej dega|will send you|we will send|discount|coupon|% off/);
      expect(t.forbidden_topics).toContain('discount');
    }
  });
});

describe('abandoned cart extraction (ADR-0010 §9)', () => {
  it('"I will complete it" is will_complete — "recovered" is reserved for attribution', () => {
    expect(
      parseExtraction('abandoned_cart_v1', { outcome: 'will_complete', confidence: 0.9 }),
    ).toMatchObject({
      ok: true,
    });
    expect(parseExtraction('abandoned_cart_v1', { outcome: 'recovered', confidence: 0.9 }).ok).toBe(
      false,
    );
  });

  it('keeps wants_link as a boolean only', () => {
    const r = parseExtraction('abandoned_cart_v1', {
      outcome: 'will_complete',
      wants_link: true,
      confidence: 0.8,
    });
    expect(r).toMatchObject({ ok: true, value: { wants_link: true } });
    expect(
      parseExtraction('abandoned_cart_v1', {
        outcome: 'will_complete',
        wants_link: 'yes',
        confidence: 1,
      }).ok,
    ).toBe(false);
  });
});

describe('feedback extraction (ADR-0010 §7)', () => {
  it('accepts a score, a category and a short comment', () => {
    const r = parseExtraction('feedback_v1', {
      outcome: 'feedback_given',
      nps: 9,
      comment: 'Arrived early',
      confidence: 0.95,
    });
    expect(r).toMatchObject({ ok: true, value: { nps: 9 } });
  });

  it('a delivery problem is needs_merchant_action with a category', () => {
    expect(
      parseExtraction('feedback_v1', {
        outcome: 'needs_merchant_action',
        issue_category: 'damaged',
        confidence: 0.9,
      }),
    ).toMatchObject({ ok: true });
  });

  it('rejects an out-of-range score, an unknown category, an overlong comment and billable outcomes', () => {
    expect(
      parseExtraction('feedback_v1', { outcome: 'feedback_given', nps: 11, confidence: 1 }).ok,
    ).toBe(false);
    expect(
      parseExtraction('feedback_v1', {
        outcome: 'feedback_given',
        issue_category: 'rude',
        confidence: 1,
      }).ok,
    ).toBe(false);
    expect(
      parseExtraction('feedback_v1', {
        outcome: 'feedback_given',
        comment: 'x'.repeat(301),
        confidence: 1,
      }).ok,
    ).toBe(false);
    // A feedback call can never produce a billable outcome (invariant 11).
    for (const billable of [
      'confirmed',
      'confirmed_with_changes',
      'cancelled',
      'rescheduled',
      'booked',
    ])
      expect(outcomesOf('feedback_v1')).not.toContain(billable);
    expect(outcomesOf('abandoned_cart_v1')).not.toContain('confirmed');
  });
});
