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
      say: 'Bahut achha. Aap {{brand}} ki website par apne cart se order kabhi bhi poora kar sakte hain.',
      outcome: 'will_complete',
    },
    {
      intent: 'wants_link',
      say: 'Zaroor. Main {{brand}} ki team ko bata deti hoon ki aapko cart ka link chahiye.',
      outcome: 'will_complete',
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

export const ABANDONED_CART_EN_IN: ScriptTemplate = {
  use_case: 'abandoned_cart',
  locale: 'en-IN',
  opening:
    'Hi {{customer_name}}, this is an automated AI assistant calling from {{brand}}. This call is being recorded.',
  purpose_line:
    'You left {{cart_summary}} in your cart at {{brand}}. Can I help you finish your order?',
  branches: [
    {
      intent: 'yes',
      say: 'Great. You can finish your order from your cart on the {{brand}} website any time.',
      outcome: 'will_complete',
    },
    {
      intent: 'wants_link',
      say: 'Sure. I will let the {{brand}} team know you would like the link to your cart.',
      outcome: 'will_complete',
    },
    {
      intent: 'later',
      say: 'No problem, your cart is there whenever you are ready.',
      outcome: 'will_buy_later',
    },
    {
      intent: 'price',
      say: 'I understand. I will pass that on to the {{brand}} team.',
      outcome: 'price_objection',
    },
    { intent: 'no', say: 'No problem at all. Thank you for your time.', outcome: 'not_interested' },
  ],
  closing: 'Thank you, and have a good day.',
  extraction: 'abandoned_cart_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount'],
  facts: [],
  opt_out_line:
    'If you would rather not get calls like this, just say "stop calling" and we will not call again.',
};

export const FEEDBACK_HI_IN: ScriptTemplate = {
  use_case: 'feedback',
  locale: 'hi-IN',
  opening:
    'Namaste {{customer_name}}, main {{brand}} ki taraf se automated AI assistant bol rahi hoon. Yeh call record ho rahi hai.',
  purpose_line:
    'Aapka order {{order_ref}} deliver ho gaya hai. Kya aap ek minute mein bata sakte hain ki sab theek tha?',
  branches: [
    {
      intent: 'happy',
      say: 'Sunkar achha laga. Shunya se das tak, aap {{brand}} ko doston ko kitna recommend karenge?',
      outcome: 'feedback_given',
    },
    {
      intent: 'problem',
      say: 'Maaf kijiye. Main yeh {{brand}} ki team ko bata deti hoon, woh aapse sampark karenge.',
      outcome: 'needs_merchant_action',
    },
    {
      intent: 'busy',
      say: 'Koi baat nahi. Aapka samay dene ke liye dhanyavaad.',
      outcome: 'not_interested',
    },
  ],
  closing: 'Dhanyavaad, {{brand}} se kharidne ke liye. Aapka din shubh ho.',
  extraction: 'feedback_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount', 'refund'],
  facts: [],
  opt_out_line: 'Agar aap aage aise call nahi chahte, toh bas "call mat karo" boliye.',
};

export const FEEDBACK_EN_IN: ScriptTemplate = {
  use_case: 'feedback',
  locale: 'en-IN',
  opening:
    'Hi {{customer_name}}, this is an automated AI assistant calling from {{brand}}. This call is being recorded.',
  purpose_line:
    'Your order {{order_ref}} was delivered. Do you have a minute to tell us if everything was okay?',
  branches: [
    {
      intent: 'happy',
      say: 'Glad to hear it. On a scale of zero to ten, how likely are you to recommend {{brand}} to a friend?',
      outcome: 'feedback_given',
    },
    {
      intent: 'problem',
      say: 'I am sorry about that. I will pass this to the {{brand}} team and they will get in touch.',
      outcome: 'needs_merchant_action',
    },
    {
      intent: 'busy',
      say: 'No problem. Thank you for your time.',
      outcome: 'not_interested',
    },
  ],
  closing: 'Thank you for shopping with {{brand}}. Have a good day.',
  extraction: 'feedback_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount', 'refund'],
  facts: [],
  opt_out_line:
    'If you would rather not get calls like this, just say "stop calling" and we will not call again.',
};

/**
 * Appointment reminder (ADR-0011 §7). A service call: the customer asked for the appointment,
 * so no promotional consent is needed — but everything clinical is out of bounds (§8). A
 * customer who wants a different time is offered real slots by the `get_slots` tool; the script
 * never names a time itself.
 */
export const APPOINTMENT_CONFIRM_EN_IN: ScriptTemplate = {
  use_case: 'appointment_confirm',
  locale: 'en-IN',
  opening:
    'Hi {{customer_name}}, this is an automated AI assistant calling from {{brand}}. This call is being recorded.',
  purpose_line:
    'You have {{service}} booked for {{date}} at {{time}}. Shall I confirm that for you?',
  branches: [
    {
      intent: 'yes',
      say: 'Confirmed, thank you. Please arrive a few minutes early.',
      outcome: 'confirmed',
    },
    {
      intent: 'reschedule',
      say: 'Of course. Let me see what times are free.',
      outcome: 'rescheduled',
      ask: 'Which of those suits you best?',
    },
    {
      intent: 'cancel',
      say: 'That is no problem, I will cancel it. You can book again whenever you like.',
      outcome: 'cancelled',
    },
    {
      intent: 'clinical',
      say: 'I am not able to advise on anything medical. I will ask the {{brand}} team to call you about that.',
      outcome: 'needs_merchant_action',
    },
    {
      intent: 'human',
      say: 'Let me connect you to the {{brand}} team.',
      outcome: 'transferred',
    },
  ],
  closing: 'Thank you, and see you then.',
  extraction: 'appointment_v1',
  max_duration_sec: 240,
  forbidden_topics: [
    'otp',
    'card',
    'upi_pin',
    'aadhaar',
    'password',
    'diagnosis',
    'prescription',
    'test_results',
    'medical_advice',
  ],
  facts: [],
  transfer_line: 'Connecting you to the {{brand}} team now, one moment.',
};

export const APPOINTMENT_CONFIRM_HI_IN: ScriptTemplate = {
  use_case: 'appointment_confirm',
  locale: 'hi-IN',
  opening:
    'Namaste {{customer_name}}, main {{brand}} ki taraf se automated AI assistant bol rahi hoon. Yeh call record ho rahi hai.',
  purpose_line: 'Aapka {{service}} {{date}} ko {{time}} baje book hai. Kya main confirm kar doon?',
  branches: [
    {
      intent: 'yes',
      say: 'Confirm ho gaya, dhanyavaad. Thoda pehle aa jaaiye.',
      outcome: 'confirmed',
    },
    {
      intent: 'reschedule',
      say: 'Bilkul. Main dekhti hoon kaun se time khaali hain.',
      outcome: 'rescheduled',
      ask: 'Inmein se aapko kaun sa time theek lagta hai?',
    },
    {
      intent: 'cancel',
      say: 'Koi baat nahi, main cancel kar deti hoon. Aap jab chahein dobara book kar sakte hain.',
      outcome: 'cancelled',
    },
    {
      intent: 'clinical',
      say: 'Main medical salah nahi de sakti. Main {{brand}} ki team ko bol deti hoon, woh aapse baat karenge.',
      outcome: 'needs_merchant_action',
    },
    {
      intent: 'human',
      say: 'Main {{brand}} ki team se connect karti hoon.',
      outcome: 'transferred',
    },
  ],
  closing: 'Dhanyavaad, milte hain.',
  extraction: 'appointment_v1',
  max_duration_sec: 240,
  forbidden_topics: [
    'otp',
    'card',
    'upi_pin',
    'aadhaar',
    'password',
    'diagnosis',
    'prescription',
    'test_results',
    'medical_advice',
  ],
  facts: [],
  transfer_line: 'Main {{brand}} ki team se connect karti hoon, ek second.',
};

/** Booking a customer who asked to be called back about an appointment (service purpose). */
export const APPOINTMENT_BOOK_EN_IN: ScriptTemplate = {
  use_case: 'appointment_book',
  locale: 'en-IN',
  opening:
    'Hi {{customer_name}}, this is an automated AI assistant calling from {{brand}}. This call is being recorded.',
  purpose_line: 'You asked us to book {{service}} for you. Would you like me to find a time now?',
  branches: [
    {
      intent: 'yes',
      say: 'Let me look at what is free.',
      outcome: 'booked',
      ask: 'Which of those times works for you?',
    },
    {
      intent: 'later',
      say: 'No problem, you can book any time on the {{brand}} website.',
      outcome: 'callback_requested',
    },
    {
      intent: 'clinical',
      say: 'I am not able to advise on anything medical — I can only find you a time. I will ask the team to call you.',
      outcome: 'needs_merchant_action',
    },
    { intent: 'no', say: 'That is fine, thank you for your time.', outcome: 'cancelled' },
    {
      intent: 'human',
      say: 'Let me connect you to the {{brand}} team.',
      outcome: 'transferred',
    },
  ],
  closing: 'Thank you, and have a good day.',
  extraction: 'appointment_v1',
  max_duration_sec: 240,
  forbidden_topics: [
    'otp',
    'card',
    'upi_pin',
    'aadhaar',
    'password',
    'diagnosis',
    'prescription',
    'test_results',
    'medical_advice',
  ],
  facts: [],
  transfer_line: 'Connecting you to the {{brand}} team now, one moment.',
};

export const DEFAULT_TEMPLATES: readonly ScriptTemplate[] = [
  COD_CONFIRM_HI_IN,
  COD_CONFIRM_EN_IN,
  LEAD_CALLBACK_EN_IN,
  ABANDONED_CART_HI_IN,
  ABANDONED_CART_EN_IN,
  FEEDBACK_HI_IN,
  FEEDBACK_EN_IN,
  APPOINTMENT_CONFIRM_HI_IN,
  APPOINTMENT_CONFIRM_EN_IN,
  APPOINTMENT_BOOK_EN_IN,
];
