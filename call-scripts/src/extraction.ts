import { z } from 'zod';

/**
 * Structured results per use case (AGENTS §9). Engine-provided extraction is validated
 * against these; an invalid result becomes `inconclusive` + an alert — never a guess.
 * `confidence` drives E-44: nothing is auto-written below 0.9.
 */

const confidence = z.number().min(0).max(1);
const shortText = z.string().max(300);

export const CodConfirmExtraction = z.object({
  outcome: z.enum([
    'confirmed',
    'confirmed_with_changes',
    'cancelled',
    'rescheduled',
    'needs_merchant_action',
    'convert_to_prepaid_requested',
    'callback_requested',
    'transferred',
    'wrong_number',
    'opt_out',
    'minor_answered',
    'recording_refused',
    'no_response',
    'inconclusive',
  ]),
  cancel_reason: z
    .enum([
      'changed_mind',
      'ordered_by_mistake',
      'price',
      'found_elsewhere',
      'duplicate',
      'delivery_too_slow',
      'other',
    ])
    .optional(),
  pincode_confirmed: z.boolean().optional(),
  /** Free text from the customer — stored, shown for review, never auto-written (E-44). */
  address_change: shortText.optional(),
  reschedule_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  quantity_change: z.number().int().min(0).max(99).optional(),
  notes: shortText.optional(),
  confidence,
});

/**
 * ADR-0010 §9: "I'll complete the order" is `will_complete`. Whether the cart was actually
 * recovered is decided later by an order, never by what was said on the call.
 */
export const AbandonedCartExtraction = z.object({
  outcome: z.enum([
    'will_complete',
    'will_buy_later',
    'not_interested',
    'price_objection',
    'callback_requested',
    'wrong_number',
    'opt_out',
    'minor_answered',
    'recording_refused',
    'no_response',
    'inconclusive',
  ]),
  objection: shortText.optional(),
  /** The customer asked for the checkout link — the merchant's messaging sends it (ADR-0010 §10). */
  wants_link: z.boolean().optional(),
  follow_up_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: shortText.optional(),
  confidence,
});

export const LeadCallbackExtraction = z.object({
  outcome: z.enum([
    'booked',
    'qualified',
    'not_interested',
    'callback_requested',
    'transferred',
    'wrong_number',
    'opt_out',
    'minor_answered',
    'recording_refused',
    'no_response',
    'inconclusive',
  ]),
  callback_time: z.string().max(64).optional(),
  notes: shortText.optional(),
  confidence,
});

export const AppointmentExtraction = z.object({
  outcome: z.enum([
    'confirmed',
    'rescheduled',
    'cancelled',
    'booked',
    'transferred',
    'callback_requested',
    /** Anything the agent may not handle — a clinical question above all (ADR-0011 §8). */
    'needs_merchant_action',
    'wrong_number',
    'opt_out',
    'minor_answered',
    'recording_refused',
    'no_response',
    'inconclusive',
  ]),
  /** The slot the agent booked through `book_slot`, when it did (ADR-0011 §6). */
  appointment_id: z.string().max(40).optional(),
  new_slot: z.string().max(64).optional(),
  cancel_reason: shortText.optional(),
  notes: shortText.optional(),
  confidence,
});

/** Post-delivery feedback (ADR-0010 §7). A promotional call: short, one question, easy to decline. */
export const FeedbackExtraction = z.object({
  outcome: z.enum([
    'feedback_given',
    'not_interested',
    'callback_requested',
    'needs_merchant_action',
    'wrong_number',
    'opt_out',
    'minor_answered',
    'recording_refused',
    'no_response',
    'inconclusive',
  ]),
  /** 0–10: "how likely are you to recommend…". */
  nps: z.number().int().min(0).max(10).optional(),
  /** What went wrong, when something did — a problem becomes a ticket-worthy `needs_merchant_action`. */
  issue_category: z
    .enum(['damaged', 'wrong_item', 'missing_item', 'late', 'quality', 'packaging', 'other'])
    .optional(),
  /** The customer's words, shortened. Shown in the dashboard; never sent in webhooks. */
  comment: shortText.optional(),
  confidence,
});

/** Inbound support calls (ADR-0006). Never outcome-billed; inbound is billed per minute. */
export const InboundSupportExtraction = z.object({
  outcome: z.enum([
    'resolved',
    'ticket_created',
    'transferred',
    'callback_requested',
    'abandoned',
    'opt_out',
    'spam',
    'inconclusive',
  ]),
  category: z
    .enum([
      'order_status',
      'cancellation',
      'address_change',
      'refund',
      'return',
      'delivery',
      'product',
      'complaint',
      'callback',
      'other',
    ])
    .optional(),
  summary: shortText.optional(),
  confidence,
});

export const EXTRACTION_SCHEMAS = {
  cod_confirm_v1: CodConfirmExtraction,
  abandoned_cart_v1: AbandonedCartExtraction,
  lead_callback_v1: LeadCallbackExtraction,
  appointment_v1: AppointmentExtraction,
  feedback_v1: FeedbackExtraction,
  inbound_support_v1: InboundSupportExtraction,
} as const;

export type ExtractionName = keyof typeof EXTRACTION_SCHEMAS;

export type Extraction<N extends ExtractionName> = z.infer<(typeof EXTRACTION_SCHEMAS)[N]>;

export type ParseExtractionResult =
  | { ok: true; value: { outcome: string; confidence: number } & Record<string, unknown> }
  | { ok: false; error: string };

/** Never throws; the results-consumer turns `ok: false` into `inconclusive` + alert. */
export function parseExtraction(name: string, raw: unknown): ParseExtractionResult {
  const schema = (EXTRACTION_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[name];
  if (schema === undefined) return { ok: false, error: `unknown extraction schema ${name}` };
  const r = schema.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  return {
    ok: true,
    value: r.data as { outcome: string; confidence: number } & Record<string, unknown>,
  };
}

/**
 * An extraction schema as flat JSON Schema, for engines that collect the result themselves
 * (Retell's post-call analysis, P6-ENG-1). Our schemas are flat objects of enums, strings,
 * numbers and booleans; anything else is a programming error and throws at agent creation, not
 * on a live call. The engine's answer is still validated with `parseExtraction` afterwards.
 */
export type ExtractionJsonSchema = {
  readonly type: 'object';
  readonly properties: Readonly<
    Record<
      string,
      | { readonly type: 'string'; readonly enum: readonly string[] }
      | { readonly type: 'string' | 'number' | 'integer' | 'boolean' }
    >
  >;
  readonly required: readonly string[];
};

export function extractionJsonSchema(name: string): ExtractionJsonSchema {
  const schema = (EXTRACTION_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[name];
  if (schema === undefined || !(schema instanceof z.ZodObject))
    throw new Error(`unknown extraction schema ${name}`);
  const properties: Record<string, ExtractionJsonSchema['properties'][string]> = {};
  const required: string[] = [];
  for (const [key, raw] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    let field = raw;
    const optional = field instanceof z.ZodOptional;
    if (field instanceof z.ZodOptional) field = field.unwrap() as z.ZodTypeAny;
    if (field instanceof z.ZodEnum)
      properties[key] = { type: 'string', enum: field.options as string[] };
    else if (field instanceof z.ZodString) properties[key] = { type: 'string' };
    else if (field instanceof z.ZodNumber)
      properties[key] = { type: field.isInt ? 'integer' : 'number' };
    else if (field instanceof z.ZodBoolean) properties[key] = { type: 'boolean' };
    else throw new Error(`extraction ${name}.${key}: unsupported field type`);
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required };
}
