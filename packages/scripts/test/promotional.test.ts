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
  /** Every promotional template we ship, in every locale (P6-CMP-2 added five more). */
  const allPromotional = DEFAULT_TEMPLATES.filter((t) =>
    ['abandoned_cart', 'feedback', 'reactivation'].includes(t.use_case),
  );

  it('validate, carry an opt-out line and are shipped by default', () => {
    for (const t of promotional) {
      expect(validateScript(t), `${t.use_case}/${t.locale}`).toMatchObject({ ok: true });
      expect(t.opt_out_line).toBeTruthy();
      expect(DEFAULT_TEMPLATES).toContain(t);
    }
  });

  it('every promotional template in every locale can be opted out of and forbids discounts', () => {
    // Language-independent rules, so the Phase 6 locales are held to them too.
    for (const t of allPromotional) {
      expect(validateScript(t), `${t.use_case}/${t.locale}`).toMatchObject({ ok: true });
      expect(t.opt_out_line, `${t.use_case}/${t.locale}`).toBeTruthy();
      expect(t.forbidden_topics, `${t.use_case}/${t.locale}`).toContain('discount');
      for (const v of variableRefs(
        [t.opening, t.purpose_line, t.closing, ...t.branches.map((b) => b.say)].join(' '),
      ))
        expect(VARIABLES_ALLOWED[t.use_case], `${t.use_case}/${t.locale}`).toContain(v);
    }
    // The five Phase 6 locales are actually there.
    const locales = allPromotional.map((t) => t.locale);
    for (const l of ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES']) expect(locales).toContain(l);
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

describe('Phase 6 locales (P6-CMP-2)', () => {
  const phase6 = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES'] as const;

  it('every Phase 6 locale has a cart and an appointment script, and both validate', () => {
    for (const locale of phase6)
      for (const useCase of ['abandoned_cart', 'appointment_confirm']) {
        const t = DEFAULT_TEMPLATES.find((x) => x.locale === locale && x.use_case === useCase);
        expect(t, `${useCase}/${locale}`).toBeDefined();
        if (t !== undefined)
          expect(validateScript(t), `${useCase}/${locale}`).toMatchObject({ ok: true });
      }
  });

  it('an appointment script never opens a clinical conversation, in any language', () => {
    for (const t of DEFAULT_TEMPLATES.filter((x) => x.use_case === 'appointment_confirm')) {
      for (const topic of ['diagnosis', 'prescription', 'test_results', 'medical_advice'])
        expect(t.forbidden_topics, t.locale).toContain(topic);
      // Every one has a branch for "the customer asked something medical".
      expect(
        t.branches.some((b) => b.outcome === 'needs_merchant_action'),
        t.locale,
      ).toBe(true);
    }
  });

  it('the disclosure is the FIRST thing said, in the language of the call', () => {
    // validateScript enforces it; this pins the intent so a "nicer" greeting cannot creep in.
    for (const t of DEFAULT_TEMPLATES) {
      const firstSentence = t.opening.split(/[.!?।]/)[0] ?? '';
      expect(firstSentence.length, `${t.use_case}/${t.locale}`).toBeGreaterThan(10);
      expect(validateScript({ ...t, opening: 'Hello.' }).ok, `${t.use_case}/${t.locale}`).toBe(
        false,
      );
    }
  });
});
