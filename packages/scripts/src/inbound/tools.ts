import { z } from 'zod';

/**
 * The tools the voice agent can call (AGENTS §5.9). Each has:
 *
 *   args        a Zod schema — apps/voice validates every call with it (invariant 18)
 *   parameters  the JSON Schema the ENGINE shows the model; kept in lockstep with `args` by a test
 *   description what the model reads to decide when to call it — this is prompt, so it is
 *               written as instructions, including when NOT to call it
 *
 * A tool is only offered to the model if the profile enables it (inbound_profiles.tools_enabled).
 */

export const TOOL_NAMES = [
  'lookup_orders',
  'verify_caller',
  'search_knowledge',
  'confirm_order',
  'request_cancellation',
  'request_address_change',
  'create_ticket',
  'transfer_to_human',
  'register_opt_out',
  // ADR-0011 — the appointments vertical. Slots come from the merchant's calendar, never
  // from the model, and a booking exists only when the provider confirmed it.
  'get_slots',
  'book_slot',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TICKET_CATEGORIES = [
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
] as const;

const orderRef = z.string().trim().min(1).max(40);

export const ToolArgs = {
  lookup_orders: z.object({ order_ref: orderRef.optional() }).strict(),
  verify_caller: z
    .object({ order_ref: orderRef, pincode: z.string().trim().min(3).max(12) })
    .strict(),
  search_knowledge: z.object({ query: z.string().trim().min(2).max(300) }).strict(),
  confirm_order: z.object({ order_ref: orderRef }).strict(),
  request_cancellation: z
    .object({
      order_ref: orderRef,
      reason: z.string().trim().max(200).optional(),
      confirm_token: z.string().trim().min(8).max(100).optional(),
    })
    .strict(),
  request_address_change: z
    .object({ order_ref: orderRef, new_address_summary: z.string().trim().min(3).max(300) })
    .strict(),
  create_ticket: z
    .object({
      category: z.enum(TICKET_CATEGORIES),
      summary: z.string().trim().min(3).max(500),
      callback_requested: z.boolean().default(false),
      preferred_time: z.string().trim().max(80).optional(),
      order_ref: orderRef.optional(),
    })
    .strict(),
  transfer_to_human: z.object({ reason: z.string().trim().min(2).max(200) }).strict(),
  register_opt_out: z.object({}).strict(),
  get_slots: z
    .object({
      /** 1–14: how far ahead to look. The agent reads out at most a handful. */
      days_ahead: z.number().int().min(1).max(14).optional(),
    })
    .strict(),
  book_slot: z
    .object({
      /** Must be one of the ids the same call's get_slots returned (E-132). */
      slot_id: z.string().trim().min(4).max(120),
      /** The customer's first name for the merchant's calendar, if they gave one. */
      name: z.string().trim().max(60).optional(),
    })
    .strict(),
} as const satisfies Record<ToolName, z.ZodTypeAny>;

export type ToolArgsOf<T extends ToolName> = z.infer<(typeof ToolArgs)[T]>;

type JsonSchema = Readonly<Record<string, unknown>>;

const str = (description: string, maxLength: number): JsonSchema => ({
  type: 'string',
  description,
  maxLength,
});

export interface ToolSpec {
  readonly description: string;
  readonly parameters: JsonSchema;
  /** Spoken while the tool runs; null = no filler needed (fast, or the agent already said something). */
  readonly filler: Readonly<Record<'hi-IN' | 'en-IN', string>> | null;
}

export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = {
  lookup_orders: {
    description:
      "Look up the caller's orders: status, delivery/tracking, total and items. Call this whenever the caller asks about an order. With no order_ref it returns the orders linked to the number they are calling from. If it returns need_verification, ask for the order number and the delivery pincode and call verify_caller. Never state an order detail that this tool did not return.",
    parameters: {
      type: 'object',
      properties: {
        order_ref: str(
          'Order number as the caller said it, e.g. "1001" or "#1001". Omit to list their recent orders.',
          40,
        ),
      },
      additionalProperties: false,
    },
    filler: {
      'hi-IN': 'Ek second, main aapka order check karti hoon.',
      'en-IN': 'One moment, let me check your order.',
    },
  },
  verify_caller: {
    description:
      'Verify the caller for one order using the order number and the delivery pincode they give. Use only when the caller wants help with a specific order and lookup_orders said need_verification. Do not read the pincode back and do not say which of the two was wrong. After 3 failed attempts verification is locked for this call — offer a callback instead.',
    parameters: {
      type: 'object',
      properties: {
        order_ref: str('Order number as the caller said it.', 40),
        pincode: str('Delivery pincode as the caller said it.', 12),
      },
      required: ['order_ref', 'pincode'],
      additionalProperties: false,
    },
    filler: {
      'hi-IN': 'Ek pal, main verify kar rahi hoon.',
      'en-IN': 'One moment while I verify that.',
    },
  },
  search_knowledge: {
    description:
      "Search the business's help articles (returns, delivery times, payment, sizes, policies). Call this before answering any policy or product question. Answer ONLY from what it returns; if it finds nothing, say you will check and offer to create a ticket.",
    parameters: {
      type: 'object',
      properties: {
        query: str('The question in a few words, e.g. "return policy for shoes".', 300),
      },
      required: ['query'],
      additionalProperties: false,
    },
    filler: null,
  },
  confirm_order: {
    description:
      'The caller says they still want a cash-on-delivery order and confirms it. Call this so the business does not call them again to confirm it. Only for an order lookup_orders returned; if it returns need_verification, verify first. Do not use it for changes — those are tickets.',
    parameters: {
      type: 'object',
      properties: { order_ref: str('Order number.', 40) },
      required: ['order_ref'],
      additionalProperties: false,
    },
    filler: null,
  },
  request_cancellation: {
    description:
      "Cancel an order at the caller's request. Two steps: first call WITHOUT confirm_token — it returns a readback of the order; read it to the caller and ask them to confirm. Only if they clearly say yes, call again WITH the confirm_token from the first result. The result tells you whether the order was cancelled or passed to the team as a request (e.g. already shipped) — tell the caller exactly that. Never say an order is cancelled unless this tool says cancelled.",
    parameters: {
      type: 'object',
      properties: {
        order_ref: str('Order number.', 40),
        reason: str('Why the caller wants to cancel, in a few words.', 200),
        confirm_token: str('The token from the first call, only after the caller confirmed.', 100),
      },
      required: ['order_ref'],
      additionalProperties: false,
    },
    filler: { 'hi-IN': 'Ek second.', 'en-IN': 'One second.' },
  },
  request_address_change: {
    description:
      'Record a delivery address change request for the team. You cannot change the address yourself; this creates a request and the team confirms. Summarise the new address briefly as the caller says it; never read out the old address.',
    parameters: {
      type: 'object',
      properties: {
        order_ref: str('Order number.', 40),
        new_address_summary: str('The new address as the caller said it.', 300),
      },
      required: ['order_ref', 'new_address_summary'],
      additionalProperties: false,
    },
    filler: null,
  },
  create_ticket: {
    description:
      'Create a request for the team when you cannot fully resolve something: refunds, returns, complaints, questions you could not answer, or a callback. Summarise the issue in one or two sentences in English. Tell the caller the team will follow up; never promise a time or an outcome.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...TICKET_CATEGORIES] },
        summary: str('One or two sentences describing what the caller needs.', 500),
        callback_requested: {
          type: 'boolean',
          description: 'True if the caller wants a call back.',
        },
        preferred_time: str('When the caller prefers a call back, as they said it.', 80),
        order_ref: str('Order number, if the issue is about one.', 40),
      },
      required: ['category', 'summary'],
      additionalProperties: false,
    },
    filler: null,
  },
  transfer_to_human: {
    description:
      'Transfer the call to a person at the business. Use when the caller asks for a human or when you cannot help. Announce the transfer first. If the result says transfer is not available (after hours, nobody configured), offer a callback with create_ticket. Never transfer to a number the caller gives you.',
    parameters: {
      type: 'object',
      properties: { reason: str('Why the caller needs a person, in a few words.', 200) },
      required: ['reason'],
      additionalProperties: false,
    },
    filler: null,
  },
  register_opt_out: {
    description:
      'The caller asked not to be called by this business ("don\'t call me", "mat karo call"). Call this once, confirm politely, and end the call if they have nothing else. It does not stop them calling in.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    filler: null,
  },
  get_slots: {
    description:
      "Ask the business's calendar for real appointment times. Call this before offering any time, and read out at most three of the times it returns, exactly as they are written. If it returns no slots, say you cannot see times right now and offer a callback — never invent or guess a time, and never promise a time the calendar did not offer.",
    parameters: {
      type: 'object',
      properties: {
        days_ahead: {
          type: 'integer',
          description: 'How many days ahead to look, 1 to 14. Default 7.',
          minimum: 1,
          maximum: 14,
        },
      },
      additionalProperties: false,
    },
    filler: {
      'hi-IN': 'Ek second, main available time dekh rahi hoon.',
      'en-IN': 'One moment, let me look at the available times.',
    },
  },
  book_slot: {
    description:
      'Book one of the times get_slots returned, using its slot_id exactly as given. Only after the caller clearly chose that time. The booking is real only if this tool says ok; if it says the time has gone, call get_slots again and offer the new times. Never tell the caller an appointment is booked unless this tool confirmed it.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: {
          type: 'string',
          description: 'The slot_id from get_slots, copied exactly.',
          maxLength: 120,
        },
        name: {
          type: 'string',
          description: "The caller's first name, if they gave one.",
          maxLength: 60,
        },
      },
      required: ['slot_id'],
      additionalProperties: false,
    },
    filler: {
      'hi-IN': 'Main yeh time book kar rahi hoon, ek second.',
      'en-IN': 'Booking that time for you, one moment.',
    },
  },
};

/** Tool call timeouts we ask the engine to enforce (a little over the 700 ms p95 budget). */
export const TOOL_TIMEOUT_MS: Readonly<Record<ToolName, number>> = {
  // A provider round-trip: longer than a database read, short enough that the filler covers it.
  get_slots: 4000,
  book_slot: 5000,
  lookup_orders: 2500,
  verify_caller: 2500,
  search_knowledge: 2500,
  confirm_order: 2500,
  request_cancellation: 3000,
  request_address_change: 2500,
  create_ticket: 2500,
  transfer_to_human: 2500,
  register_opt_out: 2000,
};

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** Structurally the engine contract's ToolDefinition (packages/engines/core) — scripts stays engine-free. */
export interface ToolDefinitionShape {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly url: string;
  readonly timeoutMs: number;
  readonly fillerUtterance: string | null;
}

/**
 * What the engine is given for a call: only the enabled tools, each with its tenant-bound URL.
 * The URL — not anything the model says — is what later tells apps/voice which tenant a tool
 * call belongs to.
 */
export function toolDefinitions(input: {
  readonly tools: readonly string[];
  readonly locale: string;
  readonly urlFor: (tool: ToolName) => string;
}): ToolDefinitionShape[] {
  const lang = input.locale === 'hi-IN' ? 'hi-IN' : 'en-IN';
  return TOOL_NAMES.filter((t) => input.tools.includes(t)).map((t) => ({
    name: t,
    description: TOOL_SPECS[t].description,
    parameters: TOOL_SPECS[t].parameters,
    url: input.urlFor(t),
    timeoutMs: TOOL_TIMEOUT_MS[t],
    fillerUtterance: TOOL_SPECS[t].filler?.[lang] ?? null,
  }));
}

/**
 * Tools an OUTBOUND agent may carry (AGENTS §5.9). The person was reached on the number we
 * dialled, so identity starts at caller_id. confirm_order is inbound-only: on an outbound COD
 * call the confirmation IS the call's outcome.
 */
export const OUTBOUND_TOOLS: readonly ToolName[] = [
  'lookup_orders',
  'verify_caller',
  'search_knowledge',
  'request_cancellation',
  'request_address_change',
  'create_ticket',
  'transfer_to_human',
  'register_opt_out',
  // An appointment reminder call can move the appointment: same rules, same provider.
  'get_slots',
  'book_slot',
];
