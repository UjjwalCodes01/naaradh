import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import WORDING from '../consent-wording.json';

/**
 * The call-consent checkbox (E-13, ADR-0010 §2). Consent must be a positive act: the box starts
 * unticked and nothing else (marketing flags, a phone on the order) is ever treated as consent.
 * Ticking writes the wording VERSION the shopper saw; unticking removes it, which revokes the
 * grant on the next checkouts/update.
 */
export default async () => {
  render(<CallConsent />, document.body);
};

function wordingFor(language, storeName) {
  const text = language.toLowerCase().startsWith('hi')
    ? WORDING.text['hi-IN']
    : WORDING.text['en-IN'];
  return text.replace('{{store}}', storeName);
}

function CallConsent() {
  const attributes = shopify.attributes.value ?? [];
  const current = attributes.find((a) => a.key === WORDING.attribute)?.value ?? '';
  const label = wordingFor(shopify.localization.language.value.isoCode, shopify.shop.name);

  async function onChange(event) {
    const ticked = event.currentTarget.checked;
    await shopify.applyAttributeChange(
      ticked
        ? { type: 'updateAttribute', key: WORDING.attribute, value: WORDING.version }
        : { type: 'removeAttribute', key: WORDING.attribute },
    );
  }

  return <s-checkbox checked={current === WORDING.version} label={label} onChange={onChange} />;
}
