/**
 * Per-locale disclosure phrases (invariant 7). A script's opening must contain at least one
 * AI phrase AND one recording phrase from its locale, or it does not validate and cannot be
 * approved. Matching is case-insensitive on collapsed whitespace.
 *
 * TODO_LEGAL: wording is a draft. The lawyer's approved phrasing per language replaces these
 * lists; the validator and tests do not change.
 *
 * Why phrases and not a fixed sentence: merchants may edit an opening within guardrails
 * (SPEC §8.4 step 5). What may not change is that the first thing a customer hears says
 * "this is an AI" and "this is recorded" — TRAI auto-dialer disclosure, EU AI Act Art. 50,
 * and recording consent, all in one breath.
 */
export interface DisclosurePhrases {
  readonly ai: readonly string[];
  readonly recording: readonly string[];
}

export const DISCLOSURES: Readonly<Record<string, DisclosurePhrases>> = {
  'hi-IN': {
    ai: [
      'automated ai assistant',
      'ai assistant bol',
      'automated call',
      'computer se call',
      'ai call',
    ],
    recording: [
      'record ho rahi hai',
      'record kiya ja raha hai',
      'recorded call',
      'call record hogi',
    ],
  },
  'en-IN': {
    ai: ['automated ai', 'ai assistant', 'automated call', 'an ai', 'artificial intelligence'],
    recording: ['being recorded', 'is recorded', 'will be recorded', 'call is recorded'],
  },
  'en-US': {
    ai: [
      'automated ai',
      'ai assistant',
      'automated call',
      'an ai',
      'artificial intelligence',
      'virtual assistant',
    ],
    recording: ['being recorded', 'is recorded', 'will be recorded', 'may be recorded'],
  },
  'en-GB': {
    ai: ['automated ai', 'ai assistant', 'automated call', 'an ai', 'artificial intelligence'],
    recording: ['being recorded', 'is recorded', 'will be recorded'],
  },
  'de-DE': {
    ai: ['ki-assistent', 'ki assistent', 'automatisierter anruf', 'künstliche intelligenz'],
    recording: ['aufgezeichnet', 'wird aufgenommen'],
  },
  'fr-FR': {
    ai: ['assistant ia', 'intelligence artificielle', 'appel automatisé'],
    recording: ['enregistré', 'est enregistrée', 'sera enregistré'],
  },
  'es-ES': {
    ai: ['asistente de ia', 'inteligencia artificial', 'llamada automatizada'],
    recording: ['grabada', 'está siendo grabada', 'será grabada'],
  },
};

export const SUPPORTED_LOCALES = Object.keys(DISCLOSURES);

/**
 * The question asked right after the disclosure where every party must agree to a recording
 * (P6-CMP-1, `recordingConsentFor()` in packages/compliance). Not merchant-editable: it is
 * appended to the approved opening at render time, never stored in a script.
 *
 * TODO_LEGAL: draft wording, reviewed with the rest of the disclosures. de/fr/es need a native
 * speaker, like the P6-CMP-2 scripts.
 */
export const RECORDING_CONSENT_QUESTIONS: Readonly<Record<string, string>> = {
  'hi-IN': 'Kya aapko call record hone mein koi aapatti to nahin hai?',
  'en-IN': 'Is it all right with you that this call is recorded?',
  'en-US': 'Is it okay with you that this call is recorded?',
  'en-GB': 'Is it all right with you that this call is recorded?',
  'de-DE': 'Sind Sie damit einverstanden, dass dieses Gespräch aufgezeichnet wird?',
  'fr-FR': 'Acceptez-vous que cet appel soit enregistré ?',
  'es-ES': '¿Está de acuerdo en que esta llamada se grabe?',
};

export function normaliseForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
