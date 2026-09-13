import type { Message } from './mailer.js';

/**
 * Email bodies. Plain text first (it is what support staff read on phones), with a minimal
 * HTML twin. Every interpolated value goes through `esc()`; merchant-entered text (store
 * names) is data, never markup.
 */

export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function html(
  title: string,
  paragraphs: readonly string[],
  action?: { label: string; url: string },
): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${esc(p)}</p>`).join('');
  const button =
    action === undefined
      ? ''
      : `<p style="margin:20px 0"><a href="${esc(action.url)}" style="background:#1f2937;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(action.label)}</a></p>`;
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827;max-width:560px;margin:24px auto;padding:0 16px"><h2 style="font-size:18px">${esc(title)}</h2>${body}${button}<p style="color:#6b7280;font-size:12px;margin-top:32px">Naaradh · AI voice agent for commerce · naaradh.com</p></body></html>`;
}

function text(paragraphs: readonly string[], action?: { label: string; url: string }): string {
  return [
    ...paragraphs,
    ...(action === undefined ? [] : [`${action.label}: ${action.url}`]),
    '',
    '— Naaradh',
  ].join('\n\n');
}

export function loginEmail(input: {
  readonly to: string;
  readonly accountName: string;
  readonly url: string;
  readonly ttlMinutes: number;
}): Message {
  const paras = [
    `Use this link to sign in to Naaradh for ${input.accountName}. It works once and expires in ${String(input.ttlMinutes)} minutes.`,
    'If you did not ask to sign in, ignore this email — nobody can sign in without the link.',
  ];
  const action = { label: 'Sign in', url: input.url };
  return {
    to: input.to,
    subject: `Sign in to Naaradh — ${input.accountName}`,
    text: text(paras, action),
    html: html('Sign in to Naaradh', paras, action),
    tag: 'login',
  };
}

export function inviteEmail(input: {
  readonly to: string;
  readonly accountName: string;
  readonly invitedBy: string;
  readonly role: string;
  readonly url: string;
}): Message {
  const paras = [
    `${input.invitedBy} added you to ${input.accountName} on Naaradh as ${input.role}.`,
    'Naaradh answers and places calls for the store with an AI voice agent. Sign in with this email address to see calls, tickets and settings.',
  ];
  const action = { label: 'Open Naaradh', url: input.url };
  return {
    to: input.to,
    subject: `You've been added to ${input.accountName} on Naaradh`,
    text: text(paras, action),
    html: html(`Join ${input.accountName} on Naaradh`, paras, action),
    tag: 'invite',
  };
}

export type AlertKind =
  | 'complaint.received'
  | 'tenant.paused'
  | 'billing.capped'
  | 'billing.approaching_cap'
  | 'billing.status_changed'
  | 'erasure.completed';

export const ALERT_KINDS: readonly AlertKind[] = [
  'complaint.received',
  'tenant.paused',
  'billing.capped',
  'billing.approaching_cap',
  'billing.status_changed',
  'erasure.completed',
];

/** `data` is the merchant event's PII-minimised payload; only known keys are read. */
export function alertEmail(input: {
  readonly to: string;
  readonly accountName: string;
  readonly kind: AlertKind;
  readonly data: Readonly<Record<string, unknown>>;
  readonly dashboardUrl: string;
}): Message {
  const str = (k: string): string | null => {
    const v = input.data[k];
    return typeof v === 'string' ? v : null;
  };
  let subject: string;
  let paras: string[];
  let path = '/';
  switch (input.kind) {
    case 'complaint.received':
      subject = 'A complaint was recorded against your calls';
      paras = [
        'Someone complained about a call made for your store. Naaradh has stopped calling that number.',
        'Three complaints in ten days pause all calling for your account while Naaradh reviews it (E-05). Check your scripts and calling volume.',
      ];
      path = '/privacy';
      break;
    case 'tenant.paused':
      subject = 'Calling is paused for your account';
      paras = [
        `Naaradh paused calling for ${input.accountName}${str('reason') === null ? '' : ` (${str('reason') ?? ''})`}.`,
        'Customer calls to your support line go to your fallback number while paused. See the dashboard for what happens next.',
      ];
      break;
    case 'billing.capped':
      subject = 'Your spending cap is reached — outbound calls are on hold';
      paras = [
        'Your Naaradh usage reached the spending cap on your subscription, so outbound calls are on hold. Support-line calls forward to your fallback number.',
        'Raise the cap in Billing, or calls resume when the next billing period starts. Nothing is lost: held charges post once the cap allows.',
      ];
      path = '/billing';
      break;
    case 'billing.approaching_cap':
      subject = 'You are close to your spending cap';
      paras = [
        'Your usage is approaching the spending cap on your Naaradh subscription. When it is reached, outbound calls pause until the cap is raised or the period renews.',
      ];
      path = '/billing';
      break;
    case 'billing.status_changed':
      subject = 'Your Naaradh subscription changed';
      paras = [
        `Your subscription status is now: ${str('billing_status') ?? str('status') ?? 'updated'}.`,
        'If a payment failed, calling continues for a 3-day grace period; update your payment method to avoid a pause.',
      ];
      path = '/billing';
      break;
    case 'erasure.completed':
      subject = 'A data erasure request is complete';
      paras = [
        "A customer's data erasure request has been completed: recordings, transcripts and personal details are deleted. The legal record that the request was honoured is kept.",
      ];
      path = '/privacy';
      break;
  }
  const action = { label: 'Open the dashboard', url: `${input.dashboardUrl}${path}` };
  return {
    to: input.to,
    subject: `${subject} — ${input.accountName}`,
    text: text(paras, action),
    html: html(subject, paras, action),
    tag: input.kind.replace('.', '_'),
  };
}

export interface DailySummaryInput {
  readonly to: string;
  readonly accountName: string;
  readonly day: string;
  readonly dashboardUrl: string;
  readonly outbound: {
    readonly orders: number;
    readonly confirmed: number;
    readonly cancelledBeforeShip: number;
    readonly gated: number;
    readonly needsAction: number;
  };
  readonly inbound: {
    readonly calls: number;
    readonly resolvedByAgent: number;
    readonly ticketsCreated: number;
  };
  readonly ticketsOpen: number;
  /** Included when the gated-orders digest is on. */
  readonly gatedReasons: readonly { readonly title: string; readonly count: number }[] | null;
}

export function dailySummaryEmail(input: DailySummaryInput): Message {
  const o = input.outbound;
  const i = input.inbound;
  const paras = [
    `Yesterday (${input.day}) for ${input.accountName}:`,
    `Orders: ${String(o.orders)} received, ${String(o.confirmed)} confirmed, ${String(o.cancelledBeforeShip)} cancelled before shipping.`,
    `Support line: ${String(i.calls)} calls, ${String(i.resolvedByAgent)} resolved by the agent, ${String(i.ticketsCreated)} tickets created.`,
    `Open tickets: ${String(input.ticketsOpen)}. Orders needing your action: ${String(o.needsAction)}.`,
  ];
  if (input.gatedReasons !== null && o.gated > 0)
    paras.push(
      `${String(o.gated)} orders were not called: ${input.gatedReasons.map((g) => `${g.title} (${String(g.count)})`).join(', ')}.`,
    );
  const action = { label: 'Open the dashboard', url: input.dashboardUrl };
  return {
    to: input.to,
    subject: `Naaradh daily summary — ${input.accountName}, ${input.day}`,
    text: text(paras, action),
    html: html('Daily summary', paras, action),
    tag: 'daily_summary',
  };
}
