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

export const AbandonedCartExtraction = z.object({
  outcome: z.enum([
    'recovered',
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
    'wrong_number',
    'opt_out',
    'minor_answered',
    'recording_refused',
    'no_response',
    'inconclusive',
  ]),
  new_slot: z.string().max(64).optional(),
  cancel_reason: shortText.optional(),
  notes: shortText.optional(),
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
