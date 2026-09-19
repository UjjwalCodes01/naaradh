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

// ---------------------------------------------------------------------------
// Phase 6 locales (ADR-0012 groundwork, P6-CMP-2). The disclosure lines come from
// packages/scripts/src/disclosures.ts and the validator enforces them; the rest of the copy is
// a DRAFT for the merchant to review before approval.
//
// `[VERIFY: native review]` — the German, French and Spanish wording was written by an engineer,
// not a native speaker or a lawyer. Have both read it before any merchant approves it. The
// English variants differ from en-IN on purpose: no "kindly", no "do the needful", plain dates.
// ---------------------------------------------------------------------------

export const ABANDONED_CART_EN_US: ScriptTemplate = {
  use_case: 'abandoned_cart',
  locale: 'en-US',
  opening:
    'Hi {{customer_name}}, this is an automated AI assistant calling on behalf of {{brand}}. This call is being recorded.',
  purpose_line:
    'You left {{cart_summary}} in your cart at {{brand}}. Can I help you finish checking out?',
  branches: [
    {
      intent: 'yes',
      say: 'Great. Your cart is saved — you can check out any time on the {{brand}} website.',
      outcome: 'will_complete',
    },
    {
      intent: 'wants_link',
      say: 'Sure. I will let the {{brand}} team know to send you the link to your cart.',
      outcome: 'will_complete',
    },
    {
      intent: 'later',
      say: 'No problem, it will be there when you are ready.',
      outcome: 'will_buy_later',
    },
    {
      intent: 'price',
      say: 'I understand. I will pass that along to the {{brand}} team.',
      outcome: 'price_objection',
    },
    { intent: 'no', say: 'Understood. Thanks for your time.', outcome: 'not_interested' },
  ],
  closing: 'Thanks, and have a good day.',
  extraction: 'abandoned_cart_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount'],
  facts: [],
  opt_out_line:
    'If you would rather not get calls like this, just say "stop calling" and we will not call this number again.',
};

export const ABANDONED_CART_EN_GB: ScriptTemplate = {
  ...ABANDONED_CART_EN_US,
  locale: 'en-GB',
  opening:
    'Hello {{customer_name}}, this is an automated AI assistant calling on behalf of {{brand}}. This call is being recorded.',
  purpose_line:
    'You left {{cart_summary}} in your basket at {{brand}}. Can I help you finish your order?',
  branches: [
    {
      intent: 'yes',
      say: 'Lovely. Your basket is saved — you can check out whenever suits you on the {{brand}} website.',
      outcome: 'will_complete',
    },
    {
      intent: 'wants_link',
      say: 'Of course. I will let the {{brand}} team know to send you the link to your basket.',
      outcome: 'will_complete',
    },
    {
      intent: 'later',
      say: 'No problem, it will be there when you are ready.',
      outcome: 'will_buy_later',
    },
    {
      intent: 'price',
      say: 'I understand. I will pass that on to the {{brand}} team.',
      outcome: 'price_objection',
    },
    { intent: 'no', say: 'Understood. Thank you for your time.', outcome: 'not_interested' },
  ],
  closing: 'Thank you, and have a good day.',
};

export const ABANDONED_CART_DE_DE: ScriptTemplate = {
  use_case: 'abandoned_cart',
  locale: 'de-DE',
  opening:
    'Guten Tag {{customer_name}}, hier ist ein automatisierter KI-Assistent im Auftrag von {{brand}}. Dieses Gespräch wird aufgezeichnet.',
  purpose_line:
    'Sie haben {{cart_summary}} in Ihrem Warenkorb bei {{brand}} gelassen. Kann ich Ihnen helfen, die Bestellung abzuschließen?',
  branches: [
    {
      intent: 'yes',
      say: 'Sehr gern. Ihr Warenkorb ist gespeichert — Sie können die Bestellung jederzeit auf der Website von {{brand}} abschließen.',
      outcome: 'will_complete',
    },
    {
      intent: 'wants_link',
      say: 'Natürlich. Ich sage dem Team von {{brand}} Bescheid, dass Sie den Link zu Ihrem Warenkorb möchten.',
      outcome: 'will_complete',
    },
    {
      intent: 'later',
      say: 'Kein Problem, der Warenkorb bleibt gespeichert.',
      outcome: 'will_buy_later',
    },
    {
      intent: 'price',
      say: 'Das verstehe ich. Ich gebe das an das Team von {{brand}} weiter.',
      outcome: 'price_objection',
    },
    { intent: 'no', say: 'Alles klar. Vielen Dank für Ihre Zeit.', outcome: 'not_interested' },
  ],
  closing: 'Vielen Dank und einen schönen Tag.',
  extraction: 'abandoned_cart_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount'],
  facts: [],
  opt_out_line:
    'Wenn Sie keine solchen Anrufe wünschen, sagen Sie einfach "nicht mehr anrufen" — dann rufen wir diese Nummer nicht wieder an.',
};

export const ABANDONED_CART_FR_FR: ScriptTemplate = {
  use_case: 'abandoned_cart',
  locale: 'fr-FR',
  opening:
    'Bonjour {{customer_name}}, je suis un assistant IA automatisé qui appelle de la part de {{brand}}. Cet appel est enregistré.',
  purpose_line:
    'Vous avez laissé {{cart_summary}} dans votre panier chez {{brand}}. Puis-je vous aider à finaliser votre commande ?',
  branches: [
    {
      intent: 'yes',
      say: 'Très bien. Votre panier est conservé — vous pouvez finaliser la commande quand vous voulez sur le site de {{brand}}.',
      outcome: 'will_complete',
    },
    {
      intent: 'wants_link',
      say: "Bien sûr. Je préviens l'équipe de {{brand}} pour qu'elle vous envoie le lien vers votre panier.",
      outcome: 'will_complete',
    },
    {
      intent: 'later',
      say: 'Pas de souci, votre panier vous attend.',
      outcome: 'will_buy_later',
    },
    {
      intent: 'price',
      say: "Je comprends. Je transmets votre remarque à l'équipe de {{brand}}.",
      outcome: 'price_objection',
    },
    { intent: 'no', say: 'Très bien. Merci de votre temps.', outcome: 'not_interested' },
  ],
  closing: 'Merci et bonne journée.',
  extraction: 'abandoned_cart_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount'],
  facts: [],
  opt_out_line:
    'Si vous ne souhaitez plus recevoir ce type d\'appel, dites simplement "ne plus appeler" et nous ne rappellerons pas ce numéro.',
};

export const ABANDONED_CART_ES_ES: ScriptTemplate = {
  use_case: 'abandoned_cart',
  locale: 'es-ES',
  opening:
    'Hola {{customer_name}}, soy un asistente de IA automatizado que llama de parte de {{brand}}. Esta llamada está siendo grabada.',
  purpose_line:
    'Dejaste {{cart_summary}} en tu cesta de {{brand}}. ¿Puedo ayudarte a terminar el pedido?',
  branches: [
    {
      intent: 'yes',
      say: 'Perfecto. Tu cesta está guardada — puedes terminar el pedido cuando quieras en la web de {{brand}}.',
      outcome: 'will_complete',
    },
    {
      intent: 'wants_link',
      say: 'Claro. Aviso al equipo de {{brand}} para que te envíe el enlace a tu cesta.',
      outcome: 'will_complete',
    },
    {
      intent: 'later',
      say: 'Sin problema, la cesta te espera.',
      outcome: 'will_buy_later',
    },
    {
      intent: 'price',
      say: 'Lo entiendo. Se lo comento al equipo de {{brand}}.',
      outcome: 'price_objection',
    },
    { intent: 'no', say: 'De acuerdo. Gracias por tu tiempo.', outcome: 'not_interested' },
  ],
  closing: 'Gracias y que tengas un buen día.',
  extraction: 'abandoned_cart_v1',
  max_duration_sec: 150,
  forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password', 'discount'],
  facts: [],
  opt_out_line:
    'Si prefieres no recibir estas llamadas, di "no me llaméis" y no volveremos a llamar a este número.',
};

export const APPOINTMENT_CONFIRM_EN_US: ScriptTemplate = {
  ...APPOINTMENT_CONFIRM_EN_IN,
  locale: 'en-US',
  opening:
    'Hi {{customer_name}}, this is an automated AI assistant calling on behalf of {{brand}}. This call is being recorded.',
  purpose_line: 'You have {{service}} scheduled for {{date}} at {{time}}. Can I confirm that?',
};

export const APPOINTMENT_CONFIRM_EN_GB: ScriptTemplate = {
  ...APPOINTMENT_CONFIRM_EN_IN,
  locale: 'en-GB',
  opening:
    'Hello {{customer_name}}, this is an automated AI assistant calling on behalf of {{brand}}. This call is being recorded.',
  purpose_line: 'You have {{service}} booked for {{date}} at {{time}}. Shall I confirm that?',
};

export const APPOINTMENT_CONFIRM_DE_DE: ScriptTemplate = {
  use_case: 'appointment_confirm',
  locale: 'de-DE',
  opening:
    'Guten Tag {{customer_name}}, hier ist ein automatisierter KI-Assistent im Auftrag von {{brand}}. Dieses Gespräch wird aufgezeichnet.',
  purpose_line:
    'Sie haben einen Termin für {{service}} am {{date}} um {{time}}. Soll ich den Termin bestätigen?',
  branches: [
    {
      intent: 'yes',
      say: 'Der Termin ist bestätigt, vielen Dank. Bitte kommen Sie ein paar Minuten früher.',
      outcome: 'confirmed',
    },
    {
      intent: 'reschedule',
      say: 'Selbstverständlich. Ich sehe nach, welche Zeiten frei sind.',
      outcome: 'rescheduled',
      ask: 'Welcher dieser Termine passt Ihnen am besten?',
    },
    {
      intent: 'cancel',
      say: 'Kein Problem, ich storniere den Termin. Sie können jederzeit einen neuen buchen.',
      outcome: 'cancelled',
    },
    {
      intent: 'clinical',
      say: 'Zu medizinischen Fragen kann ich nichts sagen. Ich gebe das an das Team von {{brand}} weiter, man wird Sie zurückrufen.',
      outcome: 'needs_merchant_action',
    },
    {
      intent: 'human',
      say: 'Ich verbinde Sie mit dem Team von {{brand}}.',
      outcome: 'transferred',
    },
  ],
  closing: 'Vielen Dank, bis dahin.',
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
  transfer_line: 'Ich verbinde Sie jetzt mit dem Team von {{brand}}, einen Moment bitte.',
};

export const APPOINTMENT_CONFIRM_FR_FR: ScriptTemplate = {
  use_case: 'appointment_confirm',
  locale: 'fr-FR',
  opening:
    'Bonjour {{customer_name}}, je suis un assistant IA automatisé qui appelle de la part de {{brand}}. Cet appel est enregistré.',
  purpose_line:
    'Vous avez un rendez-vous pour {{service}} le {{date}} à {{time}}. Puis-je le confirmer ?',
  branches: [
    {
      intent: 'yes',
      say: "C'est confirmé, merci. Merci d'arriver quelques minutes en avance.",
      outcome: 'confirmed',
    },
    {
      intent: 'reschedule',
      say: 'Bien sûr. Je regarde les créneaux disponibles.',
      outcome: 'rescheduled',
      ask: 'Lequel de ces créneaux vous convient le mieux ?',
    },
    {
      intent: 'cancel',
      say: "Pas de problème, j'annule le rendez-vous. Vous pourrez en reprendre un quand vous voudrez.",
      outcome: 'cancelled',
    },
    {
      intent: 'clinical',
      say: "Je ne peux pas répondre aux questions médicales. Je transmets votre demande à l'équipe de {{brand}}, qui vous rappellera.",
      outcome: 'needs_merchant_action',
    },
    {
      intent: 'human',
      say: "Je vous mets en relation avec l'équipe de {{brand}}.",
      outcome: 'transferred',
    },
  ],
  closing: 'Merci, à bientôt.',
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
  transfer_line: "Je vous mets en relation avec l'équipe de {{brand}}, un instant.",
};

export const APPOINTMENT_CONFIRM_ES_ES: ScriptTemplate = {
  use_case: 'appointment_confirm',
  locale: 'es-ES',
  opening:
    'Hola {{customer_name}}, soy un asistente de IA automatizado que llama de parte de {{brand}}. Esta llamada está siendo grabada.',
  purpose_line: 'Tienes una cita para {{service}} el {{date}} a las {{time}}. ¿La confirmo?',
  branches: [
    {
      intent: 'yes',
      say: 'Confirmada, gracias. Ven unos minutos antes, por favor.',
      outcome: 'confirmed',
    },
    {
      intent: 'reschedule',
      say: 'Por supuesto. Miro qué horas hay libres.',
      outcome: 'rescheduled',
      ask: '¿Cuál de estas horas te viene mejor?',
    },
    {
      intent: 'cancel',
      say: 'Sin problema, la cancelo. Puedes pedir otra cita cuando quieras.',
      outcome: 'cancelled',
    },
    {
      intent: 'clinical',
      say: 'No puedo dar consejo médico. Se lo paso al equipo de {{brand}} y te llamarán.',
      outcome: 'needs_merchant_action',
    },
    {
      intent: 'human',
      say: 'Te paso con el equipo de {{brand}}.',
      outcome: 'transferred',
    },
  ],
  closing: 'Gracias, nos vemos.',
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
  transfer_line: 'Te paso con el equipo de {{brand}}, un momento.',
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
  // Phase 6 locales — drafts, and the non-English ones need a native review.
  ABANDONED_CART_EN_US,
  ABANDONED_CART_EN_GB,
  ABANDONED_CART_DE_DE,
  ABANDONED_CART_FR_FR,
  ABANDONED_CART_ES_ES,
  APPOINTMENT_CONFIRM_EN_US,
  APPOINTMENT_CONFIRM_EN_GB,
  APPOINTMENT_CONFIRM_DE_DE,
  APPOINTMENT_CONFIRM_FR_FR,
  APPOINTMENT_CONFIRM_ES_ES,
];
