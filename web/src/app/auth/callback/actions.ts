'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { consumeLoginToken } from '@naaradh/pipeline';
import { field } from '@/lib/actions';
import { env } from '@/lib/env';
import { clientIpHash, userAgent } from '@/lib/request';
import { db, now } from '@/lib/server';
import { sessionCookieName } from '@/lib/session';

/**
 * The emailed link lands on a page with a button rather than signing in on GET: mail
 * scanners fetch links, and a single-use token spent by a scanner would lock the user out.
 */
export async function completeSignIn(form: FormData): Promise<void> {
  const session = await consumeLoginToken(db(), {
    token: field(form, 'token'),
    userAgent: await userAgent(),
    ipHash: await clientIpHash(),
    now: now(),
  });
  if (session === null) redirect('/auth/callback?expired=1');
  (await cookies()).set(sessionCookieName(), session.sessionToken, {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: session.expiresAt,
  });
  redirect('/app');
}
