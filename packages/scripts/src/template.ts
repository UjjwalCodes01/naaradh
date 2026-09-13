import { z } from 'zod';

/**
 * The shape of a script template (AGENTS §9). Stored as `scripts.body` JSONB, immutable per
 * version. Everything a customer hears comes from here; everything the model is told comes
 * from here plus the global guardrails in render.ts.
 */

export const USE_CASES = [
  'cod_confirm',
  'abandoned_cart',
  'appointment_confirm',
  'appointment_book',
  'lead_callback',
  'delivery_reschedule',
  'feedback',
  'reactivation',
  'inbound_support',
] as const;
export type UseCase = (typeof USE_CASES)[number];

/**
 * E-72: the ONLY variable keys a template may reference and an intent may supply, per use
 * case. Anything else is dropped at ingestion. `brand` and `support_phone` come from the
 * tenant, the rest from the source event; none is ever free text longer than 120 chars.
 */
export const VARIABLES_ALLOWED: Readonly<Record<UseCase, readonly string[]>> = {
  cod_confirm: [
    'customer_name',
    'brand',
    'order_ref',
    'amount',
    'currency',
    'item_summary',
    'item_count',
    'eta_text',
    'pincode',
    'support_phone',
  ],
  abandoned_cart: [
    'customer_name',
    'brand',
    'cart_summary',
    'cart_value',
    'currency',
    'item_count',
    'support_phone',
  ],
  appointment_confirm: [
    'customer_name',
    'brand',
    'service',
    'date',
    'time',
    'location',
    'support_phone',
  ],
  appointment_book: ['customer_name', 'brand', 'service', 'location', 'support_phone'],
  lead_callback: ['customer_name', 'brand', 'topic', 'form_name', 'support_phone'],
  delivery_reschedule: ['customer_name', 'brand', 'order_ref', 'attempted_date', 'support_phone'],
  feedback: ['customer_name', 'brand', 'order_ref', 'item_summary', 'support_phone'],
  reactivation: ['customer_name', 'brand', 'support_phone'],
  inbound_support: ['brand', 'support_phone'],
};

/** Topics the agent must refuse and escalate on, baked in for every use case (SPEC §10.1). */
export const FORBIDDEN_TOPICS_REQUIRED = ['otp', 'card', 'upi_pin', 'aadhaar', 'password'] as const;

const utterance = z.string().min(1).max(600);

export const BranchSchema = z.object({
  /** Customer intent the branch handles, e.g. 'yes', 'no', 'change_address', 'human'. */
  intent: z.string().min(1).max(64),
  /** What the agent says. May reference allowed variables. */
  say: utterance,
  /** Outcome to record if the conversation ends here. */
  outcome: z.string().min(1).max(64).optional(),
  /** Follow-up question, at most one level deep. */
  ask: utterance.optional(),
});

export const ScriptTemplateSchema = z.object({
  use_case: z.enum(USE_CASES),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  /** Greeting + brand + AI disclosure + recording disclosure. The FIRST utterance, always. */
  opening: utterance,
  purpose_line: utterance,
  branches: z.array(BranchSchema).max(24),
  closing: utterance,
  /** Name of the extraction schema in extraction.ts. */
  extraction: z.string().min(1),
  max_duration_sec: z.number().int().min(30).max(900),
  forbidden_topics: z.array(z.string().min(1)).min(1),
  /** Tenant-specific facts the agent may state verbatim (return policy, delivery days). */
  facts: z.array(z.string().max(300)).max(40).default([]),
  /** Optional transfer wording; transfer itself is gated by transfer_targets. */
  transfer_line: utterance.optional(),
  opt_out_line: utterance.optional(),
});

export type ScriptTemplate = z.infer<typeof ScriptTemplateSchema>;

/** `{{name}}` references in a string. */
export function variableRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) {
    const name = m[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}
