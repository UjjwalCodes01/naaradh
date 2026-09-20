'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revokeSessions } from '@naaradh/pipeline';
import { now } from '@/lib/server';
import { actorOf, currentSession, inTenant, sessionCookieName } from '@/lib/session';

export async function signOut(): Promise<void> {
  const s = await currentSession();
  if (s !== null)
    await inTenant(s, (tx) => revokeSessions(tx, actorOf(s), { sessionId: s.sessionId }, now()));
  (await cookies()).delete(sessionCookieName());
  redirect('/login');
}
