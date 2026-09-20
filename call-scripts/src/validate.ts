import { DISCLOSURES, normaliseForMatch } from './disclosures.js';
import {
  FORBIDDEN_TOPICS_REQUIRED,
  ScriptTemplateSchema,
  VARIABLES_ALLOWED,
  variableRefs,
  type ScriptTemplate,
} from './template.js';

export interface ValidationError {
  readonly code:
    | 'schema'
    | 'locale_unsupported'
    | 'disclosure_ai_missing'
    | 'disclosure_recording_missing'
    | 'opening_too_long'
    | 'forbidden_topic_missing'
    | 'variable_not_allowed'
    | 'duplicate_branch_intent'
    | 'opt_out_line_missing';
  readonly message: string;
  readonly path?: string;
}

export type ValidationResult =
  | { ok: true; template: ScriptTemplate }
  | { ok: false; errors: readonly ValidationError[] };

/** ~6 seconds of speech at a natural pace. The disclosure must land before anything else. */
export const OPENING_MAX_CHARS = 240;

/**
 * The disclosure validator (invariant 7, AGENTS §6). Called at approval time by the API and
 * by `pnpm test` over every shipped template; a template that fails cannot be approved
 * (the DB CHECK requires `disclosure_validated_at` for status='approved').
 */
export function validateScript(input: unknown): ValidationResult {
  const parsed = ScriptTemplateSchema.safeParse(input);
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
  const t = parsed.data;
  const errors: ValidationError[] = [];

  const phrases = DISCLOSURES[t.locale];
  if (phrases === undefined) {
    errors.push({
      code: 'locale_unsupported',
      message: `no disclosure phrases for locale ${t.locale}`,
      path: 'locale',
    });
  } else {
    const opening = normaliseForMatch(t.opening);
    if (!phrases.ai.some((p) => opening.includes(p))) {
      errors.push({
        code: 'disclosure_ai_missing',
        message: 'opening must say the call is from an AI',
        path: 'opening',
      });
    }
    if (!phrases.recording.some((p) => opening.includes(p))) {
      errors.push({
        code: 'disclosure_recording_missing',
        message: 'opening must say the call is recorded',
        path: 'opening',
      });
    }
  }
  if (t.opening.length > OPENING_MAX_CHARS) {
    errors.push({
      code: 'opening_too_long',
      message: `opening must be ≤ ${String(OPENING_MAX_CHARS)} chars so the disclosure lands in the first seconds`,
      path: 'opening',
    });
  }

  for (const topic of FORBIDDEN_TOPICS_REQUIRED) {
    if (!t.forbidden_topics.includes(topic)) {
      errors.push({
        code: 'forbidden_topic_missing',
        message: `forbidden_topics must include ${topic}`,
        path: 'forbidden_topics',
      });
    }
  }

  const allowed = VARIABLES_ALLOWED[t.use_case];
  const texts: [string, string][] = [
    ['opening', t.opening],
    ['purpose_line', t.purpose_line],
    ['closing', t.closing],
    ...t.branches.flatMap((b, i): [string, string][] => [
      [`branches.${String(i)}.say`, b.say],
      ...(b.ask === undefined ? [] : [[`branches.${String(i)}.ask`, b.ask] as [string, string]]),
    ]),
    ...(t.transfer_line === undefined
      ? []
      : [['transfer_line', t.transfer_line] as [string, string]]),
    ...(t.opt_out_line === undefined ? [] : [['opt_out_line', t.opt_out_line] as [string, string]]),
  ];
  for (const [path, text] of texts) {
    for (const ref of variableRefs(text)) {
      if (!allowed.includes(ref)) {
        errors.push({
          code: 'variable_not_allowed',
          message: `{{${ref}}} is not an allowed variable for ${t.use_case}`,
          path,
        });
      }
    }
  }

  const intents = t.branches.map((b) => b.intent);
  for (const dup of intents.filter((x, i) => intents.indexOf(x) !== i)) {
    errors.push({
      code: 'duplicate_branch_intent',
      message: `branch intent '${dup}' appears twice`,
      path: 'branches',
    });
  }

  // Promotional scripts must tell the customer how to opt out (SPEC §6.6, §10.2 step 4).
  if (
    (t.use_case === 'abandoned_cart' ||
      t.use_case === 'feedback' ||
      t.use_case === 'reactivation') &&
    t.opt_out_line === undefined
  ) {
    errors.push({
      code: 'opt_out_line_missing',
      message: 'promotional scripts must include an opt_out_line',
      path: 'opt_out_line',
    });
  }

  return errors.length === 0 ? { ok: true, template: t } : { ok: false, errors };
}
