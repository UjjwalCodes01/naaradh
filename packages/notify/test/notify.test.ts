import { describe, expect, it } from 'vitest';
import {
  MailRejectedError,
  MailRetryableError,
  alertEmail,
  dailySummaryEmail,
  esc,
  loginEmail,
  postmarkMailer,
} from '../src/index.js';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

const msg = loginEmail({
  to: 'owner@client-a.example',
  accountName: 'Client <A>',
  url: 'https://app.naaradh.test/auth/callback?token=abc',
  ttlMinutes: 15,
});

describe('postmark mailer', () => {
  it('sends with the server token, no open/link tracking', async () => {
    const f = fakeFetch(200, { ErrorCode: 0, MessageID: 'm-1' });
    const mailer = postmarkMailer({
      serverToken: 'tok',
      from: 'Naaradh <no-reply@mail.naaradh.test>',
      fetchImpl: f.fetchImpl,
    });
    expect(await mailer.send(msg)).toEqual({ messageId: 'm-1' });
    expect(f.calls[0]?.url).toBe('https://api.postmarkapp.com/email');
    expect(f.calls[0]?.headers['x-postmark-server-token']).toBe('tok');
    expect(f.calls[0]?.body).toMatchObject({
      To: 'owner@client-a.example',
      Tag: 'login',
      TrackOpens: false,
      TrackLinks: 'None',
      MessageStream: 'outbound',
    });
  });

  it('429/5xx are retryable; 422 and bad recipients are rejected', async () => {
    for (const status of [429, 500, 503]) {
      const f = fakeFetch(status, {});
      await expect(
        postmarkMailer({ serverToken: 't', from: 'x@y.z', fetchImpl: f.fetchImpl }).send(msg),
      ).rejects.toBeInstanceOf(MailRetryableError);
    }
    const f = fakeFetch(422, { ErrorCode: 300, Message: 'Invalid email request' });
    await expect(
      postmarkMailer({ serverToken: 't', from: 'x@y.z', fetchImpl: f.fetchImpl }).send(msg),
    ).rejects.toBeInstanceOf(MailRejectedError);
    await expect(
      postmarkMailer({ serverToken: 't', from: 'x@y.z', fetchImpl: f.fetchImpl }).send({
        ...msg,
        to: 'nobody',
      }),
    ).rejects.toBeInstanceOf(MailRejectedError);
  });
});

describe('templates', () => {
  it('escape merchant text in HTML and keep the link', () => {
    expect(esc(`<script>"x"&'y'`)).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
    expect(msg.html).toContain('Client &lt;A&gt;');
    expect(msg.html).not.toContain('<A>');
    expect(msg.text).toContain('https://app.naaradh.test/auth/callback?token=abc');
  });

  it('alerts point at the right page and never include a phone number', () => {
    const m = alertEmail({
      to: 'owner@client-a.example',
      accountName: 'Client A',
      kind: 'billing.capped',
      data: { phone: '+916000000001', billing_status: 'capped' },
      dashboardUrl: 'https://app.naaradh.test',
    });
    expect(m.text).toContain('https://app.naaradh.test/billing');
    expect(m.text).not.toContain('+91');
  });

  it('daily summary includes the gated digest only when asked', () => {
    const base = {
      to: 'o@client-a.example',
      accountName: 'Client A',
      day: '2026-09-13',
      dashboardUrl: 'https://app.naaradh.test',
      outbound: { orders: 10, confirmed: 6, cancelledBeforeShip: 2, gated: 2, needsAction: 1 },
      inbound: { calls: 4, resolvedByAgent: 3, ticketsCreated: 1 },
      ticketsOpen: 2,
    };
    expect(dailySummaryEmail({ ...base, gatedReasons: null }).text).not.toContain('not called');
    expect(
      dailySummaryEmail({ ...base, gatedReasons: [{ title: 'Outside calling hours', count: 2 }] })
        .text,
    ).toContain('Outside calling hours (2)');
  });
});
