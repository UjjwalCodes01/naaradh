import { z } from 'zod';
import { sanitiseValue } from '../variables.js';

/**
 * P7-INB-1: an IVR-style menu on the support line — "for order status, press or say 1".
 *
 * A menu grants nothing. It is spoken AFTER the greeting (so the AI and recording disclosure is
 * still the first thing a caller hears, invariant 7) and it only tells the agent which topic the
 * caller chose. Every rule still applies to what happens next: "press 0 for a person" still goes
 * through transfer_to_human, to a verified target, in its hours (invariant 19); a choice about an
 * order still needs the caller verified (invariant 17).
 *
 * Whether keys can be PRESSED depends on the engine (`capabilities().keypadInput`). Where they
 * cannot, the menu says "say 1" rather than "press or say 1", so nobody presses a key that does
 * nothing.
 */

export const MENU_MAX_OPTIONS = 6;
const LABEL_MAX = 40;

export const MenuOption = z.object({
  key: z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']),
  label: z.string().trim().min(2).max(LABEL_MAX),
});
export type MenuOption = z.infer<typeof MenuOption>;

export const Menu = z
  .array(MenuOption)
  .max(MENU_MAX_OPTIONS)
  .default([])
  .refine((m) => new Set(m.map((o) => o.key)).size === m.length, 'each key may be used once');

/**
 * One sentence per option, per locale. `{label}` is the merchant's text, `{key}` the digit.
 * de/fr/es are `[VERIFY: native review]`, like the outbound scripts in those languages.
 */
export const MENU_PHRASES: Readonly<
  Record<string, { readonly press: string; readonly say: string }>
> = {
  'en-IN': { press: 'For {label}, press or say {key}.', say: 'For {label}, say {key}.' },
  'en-US': { press: 'For {label}, press or say {key}.', say: 'For {label}, say {key}.' },
  'en-GB': { press: 'For {label}, press or say {key}.', say: 'For {label}, say {key}.' },
  'hi-IN': {
    press: '{label} ke liye {key} dabaaiye ya boliye.',
    say: '{label} ke liye {key} boliye.',
  },
  'de-DE': {
    press: 'Für {label} drücken oder sagen Sie {key}.',
    say: 'Für {label} sagen Sie {key}.',
  },
  'fr-FR': {
    press: 'Pour {label}, appuyez sur {key} ou dites {key}.',
    say: 'Pour {label}, dites {key}.',
  },
  'es-ES': { press: 'Para {label}, pulse o diga {key}.', say: 'Para {label}, diga {key}.' },
};

const clean = (label: string) => sanitiseValue(label, LABEL_MAX).value;

/** What the caller hears after the greeting; empty when there is no menu. */
export function menuSentence(locale: string, menu: readonly MenuOption[], keypad: boolean): string {
  const phrases = MENU_PHRASES[locale];
  if (menu.length === 0 || phrases === undefined) return '';
  const template = keypad ? phrases.press : phrases.say;
  return menu
    .map((o) => template.replaceAll('{label}', clean(o.label)).replaceAll('{key}', o.key))
    .join(' ');
}

/** What the agent is told about the menu it just read out. */
export function menuPromptLines(menu: readonly MenuOption[], keypad: boolean): string[] {
  if (menu.length === 0) return [];
  return [
    `You read the caller a menu. If they ${keypad ? 'press or say' : 'say'} one of these numbers, it is the topic they chose: ${menu
      .map((o) => `${o.key} = ${clean(o.label)}`)
      .join('; ')}.`,
    'A menu choice is only a topic. Every rule above still applies to it: a choice to speak to someone still goes through transfer_to_human and its checks, and a choice about an order still needs the caller verified.',
    keypad
      ? 'Keypad presses reach you as digits in the caller’s turn. A number you did not offer is not a choice: say the options again.'
      : 'A number you did not offer is not a choice: say the options again.',
  ];
}
