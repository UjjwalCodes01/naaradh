/**
 * Public legal and policy pages (SPEC §7.4, §13). These are DRAFTS written from the product's
 * actual behaviour; every page carries a visible "pending legal review" notice until counsel
 * signs off ([LEGAL]). Keep statements here true to the code: retention numbers, where data
 * lives (ADR-0004: database on Neon, Singapore; recordings in GCS Mumbai — Q-16), what is
 * billed (invariant 11). Changing behaviour means changing this file in the same PR.
 */

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs?: readonly string[];
  readonly bullets?: readonly string[];
}

export interface LegalPage {
  readonly title: string;
  readonly summary: string;
  readonly updated: string;
  readonly draft: boolean;
  readonly sections: readonly LegalSection[];
}

const UPDATED = '2026-09-12';

export const LEGAL: Readonly<Record<string, LegalPage>> = {
  privacy: {
    title: 'Privacy Policy',
    summary:
      'What Naaradh collects when it answers or places calls for a business, why, where it is kept, for how long, and how to exercise your rights.',
    updated: UPDATED,
    draft: true,
    sections: [
      {
        heading: 'Who we are and our role',
        paragraphs: [
          'Naaradh provides an AI voice agent to online stores and other businesses ("merchants"). When a merchant uses Naaradh to call you or to answer your call, the merchant decides why your data is processed (the data fiduciary / controller) and Naaradh processes it on the merchant’s instructions (data processor). For our own website, dashboard accounts and billing, Naaradh is the data fiduciary.',
        ],
      },
      {
        heading: 'What we process',
        bullets: [
          'Your phone number — stored as a keyed hash for lookups and in encrypted form for dialling; never shown in full to merchant staff.',
          'Your name and order details that the merchant shares (order number, amount, delivery status, pincode for verification).',
          'Call recordings and transcripts, and the outcome of the call (for example “confirmed” or “cancel requested”).',
          'Consent records, do-not-call requests and complaints, kept as legal records.',
          'For dashboard users: name, email address, sign-in events and actions taken (audit log).',
        ],
      },
      {
        heading: 'Why',
        bullets: [
          'To confirm, reschedule or cancel an order you placed, or to answer your questions about it.',
          'To keep a record that proves a call was lawful: disclosure played, calling window respected, consent held where required.',
          'To bill the merchant (only definitive outcomes and connected support-line minutes are billed).',
          'To protect people from unwanted calls: suppressions, complaint handling, abuse prevention.',
        ],
      },
      {
        heading: 'What every call tells you',
        paragraphs: [
          'Every call begins by saying that you are speaking with an automated assistant and that the call is recorded. You can ask to stop at any time; saying you do not want calls adds your number to the business’s do-not-call list immediately.',
        ],
      },
      {
        heading: 'Where your data is kept',
        paragraphs: [
          'Recordings and transcripts are stored in Google Cloud Storage in Mumbai (asia-south1), encrypted with keys we control. Call metadata (hashed and encrypted numbers, outcomes, consent and suppression records) is stored in a managed PostgreSQL database hosted by Neon in Singapore. We are reviewing whether to move this database to India.',
        ],
      },
      {
        heading: 'How long',
        bullets: [
          'Recordings and transcripts: 90 days by default; each merchant can set 30–365 days.',
          'Order details cached to answer support calls: up to 180 days.',
          'Consent, do-not-call, complaint and billing records: kept as long as the law requires us to prove what happened, even after other data is erased.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          'You can ask the merchant, or us, for access, correction or erasure of your data, and you can withdraw consent. Erasure removes recordings, transcripts, your name and order details; we keep a hashed record that the request was honoured so that you are not called again. To stop all calls from every business using Naaradh, use the do-not-call page.',
          'Grievances: see the Grievance Officer page. We respond within the time the Digital Personal Data Protection Act, 2023 and its rules require.',
        ],
      },
      {
        heading: 'Sharing',
        paragraphs: [
          'We share data only with the merchant who called you or whom you called, and with the sub-processors listed on the sub-processors page (cloud hosting, voice engine, telephony, email, payments). We do not sell personal data and do not use recordings to train models for anyone else.',
        ],
      },
    ],
  },

  terms: {
    title: 'Terms of Service',
    summary: 'The agreement between Naaradh and merchants who use the service.',
    updated: UPDATED,
    draft: true,
    sections: [
      {
        heading: 'The service',
        paragraphs: [
          'Naaradh answers and places phone calls for your business with an AI voice agent, and records outcomes in your store. You configure what the agent may do; Naaradh enforces calling windows, consent, do-not-call and disclosure rules on every call and may refuse a call that would break them.',
        ],
      },
      {
        heading: 'Your responsibilities',
        bullets: [
          'You are the principal entity/sender of your calls. You warrant a lawful basis — and, for promotional calls, recorded consent — for every number you ask Naaradh to call.',
          'You approve every outbound script and inbound agent profile before it goes live, and keep your knowledge articles truthful.',
          'You register with DLT as required and keep your registration linked.',
          'You follow the Acceptable Use Policy.',
        ],
      },
      {
        heading: 'Billing',
        paragraphs: [
          'Outbound calls are billed per billable outcome: a person answered and gave a definitive answer (confirmed, confirmed with changes, cancelled, rescheduled or booked). Nothing else is billed. Support-line calls are billed per connected minute, rounded up per call. Your spending cap is respected: calls pause when it is reached.',
          'You may dispute an outcome within 7 days; accepted disputes are credited.',
        ],
      },
      {
        heading: 'Suspension',
        paragraphs: [
          'Calling pauses automatically if complaints reach the thresholds in our policy, if billing fails beyond a 3-day grace period, or for a breach of these terms. We tell you why and what happens next.',
        ],
      },
      {
        heading: 'Liability, law and disputes',
        paragraphs: [
          'Limitation of liability, indemnity for consent failures, governing law and arbitration: to be finalised with counsel.',
        ],
      },
    ],
  },

  dpa: {
    title: 'Data Processing Agreement',
    summary:
      'How Naaradh processes personal data on a merchant’s behalf (DPDP Act 2023; GDPR Art. 28 where applicable).',
    updated: UPDATED,
    draft: true,
    sections: [
      {
        heading: 'Scope and instructions',
        paragraphs: [
          'Naaradh processes customer phone numbers, names, order details, recordings and transcripts only to place and answer calls the merchant has configured, to record outcomes and to bill. The merchant’s configuration is its documented instruction.',
        ],
      },
      {
        heading: 'Security measures',
        bullets: [
          'Numbers hashed for lookups and encrypted at rest; decryption only by the dialling component.',
          'Tenant isolation enforced by database row-level security.',
          'Recordings encrypted with customer-managed keys; access by signed, short-lived links, every access logged and visible to the merchant.',
          'Every inbound webhook and engine request verified by signature before processing.',
        ],
      },
      {
        heading: 'Sub-processors',
        paragraphs: ['Listed on the sub-processors page with at least 30 days’ notice of changes.'],
      },
      {
        heading: 'Breaches, deletion, audits',
        paragraphs: [
          'Breach notification timelines, audit rights and deletion on termination: to be finalised with counsel. Data residency: see the Privacy Policy (database hosted in Singapore; recordings in Mumbai).',
        ],
      },
    ],
  },

  aup: {
    title: 'Acceptable Use Policy',
    summary: 'What Naaradh may not be used for.',
    updated: UPDATED,
    draft: true,
    sections: [
      {
        heading: 'Prohibited',
        bullets: [
          'Calling purchased or scraped lists, or anyone without a lawful basis; promotional calls without recorded consent.',
          'Deceptive scripts, impersonation, or hiding that the caller is an automated assistant.',
          'Lending, collections, insurance, securities, health advice, political campaigning, adult content or gambling.',
          'Calling emergency or premium-rate numbers; calling outside the permitted window (09:00–21:00 in India).',
          'Asking callers for OTPs, card numbers, UPI PINs, Aadhaar numbers or passwords.',
        ],
      },
      {
        heading: 'Enforcement',
        paragraphs: [
          'We may refuse calls, pause or suspend an account for a breach, and cooperate with regulators on complaints.',
        ],
      },
    ],
  },

  security: {
    title: 'Security',
    summary: 'How Naaradh protects merchant and customer data.',
    updated: UPDATED,
    draft: false,
    sections: [
      {
        heading: 'Architecture',
        bullets: [
          'Every tenant’s data isolated by PostgreSQL row-level security; services that serve merchants cannot bypass it.',
          'Phone numbers stored as keyed hashes and encrypted ciphertext; the dashboard shows masked numbers only.',
          'Recordings in Google Cloud Storage (Mumbai) with customer-managed encryption keys; playback through 15-minute signed links, each access recorded in the merchant’s access log.',
          'Shopify access tokens encrypted at rest; webhooks verified by HMAC before any processing.',
          'Dashboard sign-in by single-use email links; sessions expire after inactivity; every sign-in audited.',
        ],
      },
      {
        heading: 'Reporting a vulnerability',
        paragraphs: [
          'Write to security@naaradh.com. Please do not test against merchants’ live stores or real phone numbers.',
        ],
      },
    ],
  },

  subprocessors: {
    title: 'Sub-processors',
    summary: 'Third parties that process personal data for Naaradh.',
    updated: UPDATED,
    draft: true,
    sections: [
      {
        heading: 'Current',
        bullets: [
          'Google Cloud (Google Cloud India) — hosting, recordings storage, messaging. Mumbai, India.',
          'Neon, Inc. — managed PostgreSQL database (call metadata, merchant accounts). Singapore.',
          'Postmark (ActiveCampaign) — transactional email to merchant staff. United States. No customer data is sent by email.',
          'Shopify — for merchants who install the Shopify app; order data and billing.',
          'Razorpay — subscription billing for Indian merchants not billed through Shopify. India.',
        ],
      },
      {
        heading: 'Voice and telephony (selection in progress)',
        paragraphs: [
          'The voice engine and telephony providers for India are being selected; this list will name them, with their processing locations, before live calls begin.',
        ],
      },
    ],
  },

  cookies: {
    title: 'Cookies',
    summary: 'Naaradh uses no advertising or analytics cookies.',
    updated: UPDATED,
    draft: false,
    sections: [
      {
        heading: 'What we set',
        bullets: [
          'A session cookie when you sign in to the dashboard (strictly necessary; expires after inactivity or 7 days).',
          'Inside Shopify admin, Shopify’s own session handling for the embedded app.',
        ],
      },
      {
        heading: 'What we do not set',
        paragraphs: ['No analytics, advertising or third-party tracking cookies.'],
      },
    ],
  },

  refunds: {
    title: 'Refunds and disputes',
    summary: 'How billing disputes and refunds work.',
    updated: UPDATED,
    draft: true,
    sections: [
      {
        heading: 'Outcome disputes',
        paragraphs: [
          'If you believe a billed outcome did not meet the billable definition (for example, the “confirmation” came from a wrong number), dispute it from the order page within 7 days. We review the recording, transcript and call details. Accepted disputes are credited: on Razorpay against your next invoice, on Shopify as a refund of the usage charge.',
        ],
      },
      { heading: 'Platform fees', paragraphs: ['Platform fees are non-refundable after 14 days.'] },
    ],
  },

  contact: {
    title: 'Contact',
    summary: 'How to reach Naaradh.',
    updated: UPDATED,
    draft: false,
    sections: [
      {
        heading: 'Email',
        bullets: [
          'Support: support@naaradh.com',
          'Sales: sales@naaradh.com',
          'Privacy and grievances: privacy@naaradh.com',
          'Do-not-call: dnc@naaradh.com (or use the do-not-call page)',
          'Security: security@naaradh.com',
          'Legal: legal@naaradh.com',
        ],
      },
    ],
  },

  grievance: {
    title: 'Grievance Officer',
    summary: 'Contact for privacy grievances under the Digital Personal Data Protection Act, 2023.',
    updated: UPDATED,
    draft: true,
    sections: [
      {
        heading: 'Grievance Officer',
        paragraphs: [
          'Name and designation: to be published on incorporation.',
          'Email: privacy@naaradh.com — include the phone number or order the grievance is about, and how to reach you. We acknowledge within 48 hours.',
        ],
      },
      {
        heading: 'Before you write',
        paragraphs: [
          'To stop calls immediately, use the do-not-call page — no email needed. If the call was made for a specific store, you may also contact that store.',
        ],
      },
    ],
  },
};
