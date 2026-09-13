import { z } from 'zod';
import { DISCLOSURES, normaliseForMatch } from '../disclosures.js';
import { sanitiseValue } from '../variables.js';
import { OPENING_MAX_CHARS } from '../validate.js';
import { TOOL_NAMES, isToolName, type ToolName } from './tools.js';

/**
 * Inbound agent profiles (SPEC §10.5). The greeting is the first thing every caller hears,
 * so it passes the same disclosure validator as outbound openings (invariant 7).
 */

export const InboundProfileInput = z.object({
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  greeting: z.string().trim().min(10).max(OPENING_MAX_CHARS),
  persona: z.string().trim().max(300).nullable().default(null),
  pinnedFacts: z.array(z.string().trim().min(3).max(200)).max(20).default([]),
  toolsEnabled: z.array(z.string()).min(1),
  closedMessage: z.string().trim().min(10).max(400),
});

export type InboundProfileInput = z.infer<typeof InboundProfileInput>;

export interface ProfileValidationError {
  readonly code:
    | 'schema'
    | 'locale_unsupported'
    | 'disclosure_ai_missing'
    | 'disclosure_recording_missing'
    | 'unknown_tool'
    | 'greeting_variable_not_allowed'
    | 'duplicate_tool';
  readonly message: string;
  readonly path?: string;
}

export type ProfileValidation =
  | { ok: true; profile: InboundProfileInput & { toolsEnabled: ToolName[] } }
  | { ok: false; errors: readonly ProfileValidationError[] };

/** Only the brand may be substituted into the greeting — never a caller's name (caller ID can be spoofed). */
const GREETING_VARIABLES = new Set(['brand']);

export function validateInboundProfile(input: unknown): ProfileValidation {
  const parsed = InboundProfileInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: 'schema',
        message: i.message,
        path: i.path.join('.'),
      })),
    };
  }
  const p = parsed.data;
  const errors: ProfileValidationError[] = [];

  const phrases = DISCLOSURES[p.locale];
  if (phrases === undefined) {
    errors.push({
      code: 'locale_unsupported',
      message: `no disclosure phrases for ${p.locale}`,
      path: 'locale',
    });
  } else {
    const g = normaliseForMatch(p.greeting);
    if (!phrases.ai.some((x) => g.includes(x)))
      errors.push({
        code: 'disclosure_ai_missing',
        message: 'greeting must say the caller is speaking to an AI',
        path: 'greeting',
      });
    if (!phrases.recording.some((x) => g.includes(x)))
      errors.push({
        code: 'disclosure_recording_missing',
        message: 'greeting must say the call is recorded',
        path: 'greeting',
      });
  }

  for (const m of p.greeting.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) {
    const name = m[1];
    if (name !== undefined && !GREETING_VARIABLES.has(name))
      errors.push({
        code: 'greeting_variable_not_allowed',
        message: `{{${name}}} cannot be used in a greeting`,
        path: 'greeting',
      });
  }

  const seen = new Set<string>();
  for (const t of p.toolsEnabled) {
    if (!isToolName(t))
      errors.push({
        code: 'unknown_tool',
        message: `unknown tool ${t}; allowed: ${TOOL_NAMES.join(', ')}`,
        path: 'toolsEnabled',
      });
    if (seen.has(t))
      errors.push({ code: 'duplicate_tool', message: `${t} listed twice`, path: 'toolsEnabled' });
    seen.add(t);
  }

  return errors.length === 0
    ? { ok: true, profile: { ...p, toolsEnabled: p.toolsEnabled as ToolName[] } }
    : { ok: false, errors };
}

/**
 * Invariant 7 at CALL time: the rendered first utterance still carries both disclosures. The
 * profile was validated on write; this catches a row edited behind the API's back.
 */
export function greetingDiscloses(locale: string, text: string): boolean {
  const phrases = DISCLOSURES[locale];
  if (phrases === undefined) return false;
  const g = normaliseForMatch(text);
  return phrases.ai.some((x) => g.includes(x)) && phrases.recording.some((x) => g.includes(x));
}

/** Merchant-written text is data too (E-72): strip control/format characters, collapse, cap. */
export function sanitiseMerchantText(value: string, max: number): string {
  return sanitiseValue(value, max).value;
}

export const DEFAULT_INBOUND_GREETINGS: Readonly<Record<'hi-IN' | 'en-IN', string>> = {
  'hi-IN':
    'Namaste, {{brand}} mein aapka swagat hai. Main ek automated AI assistant hoon aur yeh call record ho rahi hai. Main aapki kya madad kar sakti hoon?',
  'en-IN':
    'Hello, thank you for calling {{brand}}. I am an automated AI assistant and this call is being recorded. How can I help you today?',
};

export const DEFAULT_CLOSED_MESSAGES: Readonly<Record<'hi-IN' | 'en-IN', string>> = {
  'hi-IN':
    '{{brand}} ko call karne ke liye dhanyavaad. Abhi hum aapki call nahi le pa rahe hain. Kripya {{hours}} ke beech dobara call karein.',
  'en-IN':
    'Thank you for calling {{brand}}. We are unable to take your call right now. Please call again during {{hours}}.',
};

export const DEFAULT_ABUSE_MESSAGES: Readonly<Record<'hi-IN' | 'en-IN', string>> = {
  'hi-IN':
    'Aapki pichhli calls hum tak pahunch chuki hain. Hamari team aapse sampark karegi. Dhanyavaad.',
  'en-IN': 'We have received your recent calls and the team will get back to you. Thank you.',
};
