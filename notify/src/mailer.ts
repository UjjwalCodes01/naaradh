/**
 * Transactional email (CLAUDE.md: Postmark, sending domain mail.naaradh.com). One interface,
 * two implementations: Postmark over plain fetch in production, an in-memory outbox for dev
 * and tests. Messages carry no customer data — merchant staff get counts, reasons and links
 * into the dashboard, never a phone number or a transcript (invariant 8).
 */

export interface Message {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Postmark tag, for delivery stats per kind ("login", "daily_summary", …). */
  readonly tag: string;
}

export interface Mailer {
  send(message: Message): Promise<{ readonly messageId: string }>;
}

/** 429, 5xx and network failures: try again later. Anything else will fail the same way again. */
export class MailRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailRetryableError';
  }
}

export class MailRejectedError extends Error {
  readonly code: number | null;
  constructor(status: number, code: number | null, message: string) {
    super(
      `Postmark ${String(status)}${code === null ? '' : ` (${String(code)})`}: ${message.slice(0, 200)}`,
    );
    this.name = 'MailRejectedError';
    this.code = code;
  }
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function postmarkMailer(config: {
  readonly serverToken: string;
  readonly from: string;
  readonly messageStream?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Mailer {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.baseUrl ?? 'https://api.postmarkapp.com';
  return {
    async send(m) {
      if (!EMAIL.test(m.to)) throw new MailRejectedError(422, null, 'invalid recipient address');
      let res: Response;
      try {
        res = await doFetch(`${base}/email`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-postmark-server-token': config.serverToken,
          },
          body: JSON.stringify({
            From: config.from,
            To: m.to,
            Subject: m.subject.slice(0, 200),
            TextBody: m.text,
            HtmlBody: m.html,
            Tag: m.tag,
            MessageStream: config.messageStream ?? 'outbound',
            TrackOpens: false,
            TrackLinks: 'None',
          }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        });
      } catch (error) {
        throw new MailRetryableError(
          `network error calling Postmark: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
      if (res.status === 429 || res.status >= 500)
        throw new MailRetryableError(`Postmark HTTP ${String(res.status)}`);
      const body = (await res.json().catch(() => null)) as {
        ErrorCode?: number;
        Message?: string;
        MessageID?: string;
      } | null;
      if (!res.ok || (body?.ErrorCode ?? 0) !== 0)
        throw new MailRejectedError(
          res.status,
          body?.ErrorCode ?? null,
          body?.Message ?? 'rejected',
        );
      return { messageId: body?.MessageID ?? '' };
    },
  };
}

/** Dev and tests: keeps what would have been sent. */
export function memoryMailer(): Mailer & { readonly sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
      return { messageId: `mem-${String(sent.length)}` };
    },
  };
}
