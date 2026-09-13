import type { ScriptTemplate } from './template.js';

/**
 * Default templates, v1. TODO_LEGAL: wording — especially the disclosure sentence — is a
 * draft pending the lawyer's per-language phrasing (SPEC §13 consent wording templates).
 * Structure follows SPEC §10.2 / §10.3.
 */

export const COD_CONFIRM_HI_IN: ScriptTemplate = {
  use_case: 'cod_confirm',
  locale: 'hi-IN',
  opening:
    'Namaste {{customer_name}}, main {{brand}} ki taraf se automated AI assistant bol rahi hoon. Yeh call record ho rahi hai.',
  purpose_line:
    'Aapne {{brand}} par {{order_ref}} ka order kiya hai, {{amount}} rupaye cash on delivery, {{item_summary}}. Kya hum ise ship kar dein?',
  branches: [
    {
      intent: 'yes',
      say: 'Dhanyavaad. Ek baar pincode confirm kar lein: {{pincode}}, sahi hai?',
      ask: 'Sahi hai?',
      outcome: 'confirmed',
    },
    {
      intent: 'yes_pincode_wrong',
      say: 'Theek hai, main note kar leti hoon; {{brand}} ki team aapse address confirm karegi.',
      outcome: 'confirmed_with_changes',
    },
    {
      intent: 'no',
      say: 'Koi baat nahi. Bas ek chhota sawaal — kya wajah hai? Mann badal gaya, galti se order hua, ya kuch aur?',
      outcome: 'cancelled',
    },
    {
      intent: 'change',
      say: 'Zaroor. Aap kya badalna chahenge — quantity, address, ya delivery date?',
      outcome: 'confirmed_with_changes',
    },
    {
      intent: 'prepaid',
      say: 'Samajh gayi. {{brand}} ki team aapko payment link bhej degi.',
      outcome: 'convert_to_prepaid_requested',
    },
    {
      intent: 'human',
      say: 'Bilkul, main aapko {{brand}} ki team se jodne ki koshish karti hoon.',
      outcome: 'transferred',
    },
    {
      intent: 'later',
      say: 'Theek hai, {{brand}} ki team aapse baad mein sampark karegi.',
      outcome: 'callback_requested',
    },
  ],
  closing: 'Dhanyavaad, {{brand}} par order karne ke liye. Aapka din shubh ho.',
  extraction: 'cod_confirm_v1',
  max_duration_sec: 120,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount', 'refund'],
  facts: [],
  transfer_line: 'Main aapko {{brand}} ki team se jod rahi hoon, ek pal rukiye.',
};

export const COD_CONFIRM_EN_IN: ScriptTemplate = {
  use_case: 'cod_confirm',
  locale: 'en-IN',
  opening:
    'Hello {{customer_name}}, this is an automated AI assistant calling on behalf of {{brand}}. This call is being recorded.',
  purpose_line:
    'You placed order {{order_ref}} with {{brand}} for {{amount}} rupees, cash on delivery: {{item_summary}}. Shall we go ahead and ship it?',
  branches: [
    {
      intent: 'yes',
      say: 'Thank you. Let me confirm your pincode: {{pincode}}. Is that right?',
      outcome: 'confirmed',
    },
    {
      intent: 'yes_pincode_wrong',
      say: 'Noted. The {{brand}} team will confirm the address with you.',
      outcome: 'confirmed_with_changes',
    },
    {
      intent: 'no',
      say: 'No problem. May I ask why — changed your mind, ordered by mistake, or something else?',
      outcome: 'cancelled',
    },
    {
      intent: 'change',
      say: 'Sure. What would you like to change — the quantity, the address, or the delivery date?',
      outcome: 'confirmed_with_changes',
    },
    {
      intent: 'human',
      say: 'Of course, let me try to connect you to the {{brand}} team.',
      outcome: 'transferred',
    },
    {
      intent: 'later',
      say: 'Understood, the {{brand}} team will get back to you.',
      outcome: 'callback_requested',
    },
  ],
  closing: 'Thank you for shopping with {{brand}}. Have a good day.',
  extraction: 'cod_confirm_v1',
  max_duration_sec: 120,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount', 'refund'],
  facts: [],
  transfer_line: 'Connecting you to the {{brand}} team now, one moment.',
};

export const LEAD_CALLBACK_EN_IN: ScriptTemplate = {
  use_case: 'lead_callback',
  locale: 'en-IN',
  opening:
    'Hi {{customer_name}}, this is an automated AI assistant calling from {{brand}}. This call is being recorded.',
  purpose_line: 'You asked us to call you back about {{topic}}. Is now a good time?',
  branches: [
    {
      intent: 'yes',
      say: 'Great. Could you tell me a little about what you are looking for?',
      outcome: 'qualified',
    },
    {
      intent: 'book',
      say: 'I can have someone from {{brand}} call you at a time that suits you. When works best?',
      outcome: 'callback_requested',
    },
    {
      intent: 'human',
      say: 'Of course, let me connect you to the {{brand}} team.',
      outcome: 'transferred',
    },
    { intent: 'no', say: 'No problem. Thank you for your time.', outcome: 'not_interested' },
  ],
  closing: 'Thank you, {{brand}} will be in touch. Goodbye.',
  extraction: 'lead_callback_v1',
  max_duration_sec: 180,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password'],
  facts: [],
};

export const ABANDONED_CART_HI_IN: ScriptTemplate = {
  use_case: 'abandoned_cart',
  locale: 'hi-IN',
  opening:
    'Namaste {{customer_name}}, main {{brand}} ki taraf se automated AI assistant bol rahi hoon. Yeh call record ho rahi hai.',
  purpose_line:
    'Aapne {{brand}} par {{cart_summary}} apne cart mein chhoda tha. Kya main order poora karne mein madad karoon?',
  branches: [
    {
      intent: 'yes',
      say: 'Bahut achha. {{brand}} aapko order poora karne ka link bhej dega.',
      outcome: 'recovered',
    },
    {
      intent: 'later',
      say: 'Theek hai, aap jab chahein poora kar sakte hain.',
      outcome: 'will_buy_later',
    },
    {
      intent: 'price',
      say: 'Samajh gayi. Main {{brand}} ki team ko bata deti hoon.',
      outcome: 'price_objection',
    },
    { intent: 'no', say: 'Koi baat nahi, dhanyavaad.', outcome: 'not_interested' },
  ],
  closing: 'Dhanyavaad. Aapka din shubh ho.',
  extraction: 'abandoned_cart_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount'],
  facts: [],
  opt_out_line: 'Agar aap aage aise call nahi chahte, toh bas "call mat karo" boliye.',
};

export const DEFAULT_TEMPLATES: readonly ScriptTemplate[] = [
  COD_CONFIRM_HI_IN,
  COD_CONFIRM_EN_IN,
  LEAD_CALLBACK_EN_IN,
  ABANDONED_CART_HI_IN,
];
