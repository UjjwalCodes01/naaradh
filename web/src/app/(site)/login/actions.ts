'use server';

import { loginEmail } from '@naaradh/notify';
import { Email, LOGIN_TOKEN_TTL_MIN, issueLoginLinks } from '@naaradh/pipeline';
import { sha256Hex } from '@naaradh/shared';
import { field, run, type ActionResult } from '@/lib/actions';
import { env } from '@/lib/env';
import { allow } from '@/lib/rate-limit';
import { clientIp, clientIpHash } from '@/lib/request';
import { db, log, mailer, now } from '@/lib/server';

const SENT =
  'If that address has a Naaradh account, a sign-in link is on its way. It works once and expires in 15 minutes.';

/**
 * Magic-link sign-in (ADR-0009). The answer is the same whether or not the address has an
 * account; per-address and per-network limits fail closed on a Redis outage.
 */
export async function requestLoginLink(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const parsed = Email.safeParse(field(form, 'email'));
    if (!parsed.success) return { ok: false, message: 'Enter a valid email address.' };
    const email = parsed.data;
    const ip = await clientIp();
    const okIp = await allow(`login-ip:${ip}`, 20, 3600, { failClosed: true });
    const okEmail = await allow(`login-email:${sha256Hex(email)}`, 5, 3600, { failClosed: true });
    if (!okIp || !okEmail)
      return { ok: false, message: 'Too many sign-in requests. Try again later.' };
    const links = await issueLoginLinks(db(), { email, ipHash: await clientIpHash(), now: now() });
    for (const l of links) {
      const url = `${env().APP_URL}/auth/callback?token=${encodeURIComponent(l.token)}`;
      try {
        await mailer().send(
          loginEmail({
            to: email,
            accountName: l.tenantName,
            url,
            ttlMinutes: LOGIN_TOKEN_TTL_MIN,
          }),
        );
      } catch (error) {
        log().error({ err: error, tenant_id: l.tenantId }, 'sign-in email failed');
      }
      if (env().NODE_ENV === 'development')
        log().info({ tenant_id: l.tenantId, url }, 'dev sign-in link');
    }
    return SENT;
  });
}
