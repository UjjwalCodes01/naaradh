import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_WORDINGS,
  CURRENT_CONSENT_WORDING,
  isKnownConsentWording,
} from '../src/promotional/consent-wording.js';

/**
 * E-13 / ADR-0010 §2: the ledger records a wording VERSION; the words a shopper actually saw
 * live in the checkout extension and the cart block. They must be the same words, or every
 * consent we record points at text nobody was shown.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const current = CONSENT_WORDINGS[CURRENT_CONSENT_WORDING];

describe('consent wording', () => {
  it('the current version exists and is not withdrawn', () => {
    expect(current).toBeDefined();
    expect(current?.status).not.toBe('withdrawn');
    expect(isKnownConsentWording(CURRENT_CONSENT_WORDING)).toBe(true);
  });

  it('only published versions count (E-106)', () => {
    expect(isKnownConsentWording(null)).toBe(false);
    expect(isKnownConsentWording('')).toBe(false);
    expect(isKnownConsentWording('yes')).toBe(false);
    expect(isKnownConsentWording('true')).toBe(false);
    expect(isKnownConsentWording('2026-09-v1')).toBe(false);
  });

  it('every wording names the store, mentions automated calls and how to stop', () => {
    for (const w of Object.values(CONSENT_WORDINGS))
      for (const text of Object.values(w.text)) {
        expect(text).toContain('{{store}}');
        expect(text.toLowerCase()).toContain('automated');
        expect(text.toLowerCase()).toContain('stop');
      }
  });

  it('the checkout extension shows exactly the current wording and writes its version', () => {
    const ext = JSON.parse(
      read('shopify/extensions/call-consent-checkout/consent-wording.json'),
    ) as {
      attribute: string;
      version: string;
      text: Record<string, string>;
    };
    expect(ext.attribute).toBe('naaradh_call_consent');
    expect(ext.version).toBe(CURRENT_CONSENT_WORDING);
    expect(ext.text).toEqual(current?.text);
    const source = read('shopify/extensions/call-consent-checkout/src/Checkout.jsx');
    // Never pre-ticked: the checked state comes only from the attribute the shopper set.
    expect(source).toContain('checked={current === WORDING.version}');
    expect(source).not.toMatch(/checked=\{true\}|defaultChecked/);
  });

  it('the cart block shows exactly the current wording and writes its version', () => {
    const liquid = read('shopify/extensions/call-consent-cart/blocks/call-consent.liquid');
    expect(liquid).toContain(`assign naaradh_version = '${CURRENT_CONSENT_WORDING}'`);
    for (const text of Object.values(current?.text ?? {}))
      expect(liquid).toContain(text.replace('{{store}}', '{{ shop.name | escape }}'));
    expect(liquid).toContain('name="attributes[naaradh_call_consent]"');
  });
});
