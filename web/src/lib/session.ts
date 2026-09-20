import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withTenant, type Tx } from '@naaradh/db';
import {
  requireRole,
  resolveWebSession,
  type Actor,
  type Role,
  type WebSession,
} from '@naaradh/pipeline';
import { env } from './env';
import { db, now } from './server';

/**
 * Dashboard sessions (ADR-0009). The cookie holds a 32-byte random secret; Postgres holds its
 * SHA-256 (resolve_web_session). `__Host-` prefix in production: Secure, path=/, no Domain —
 * the cookie cannot be set or read by any other subdomain of naaradh.com.
 */
export function sessionCookieName(): string {
  return env().NODE_ENV === 'production' ? '__Host-naaradh_session' : 'naaradh_session';
}

export const currentSession = cache(async (): Promise<WebSession | null> => {
  const token = (await cookies()).get(sessionCookieName())?.value;
  return resolveWebSession(db(), token, now());
});

export async function requireSession(minRole: Role = 'viewer'): Promise<WebSession> {
  const s = await currentSession();
  if (s === null) redirect('/login');
  requireRole(s.role, minRole);
  return s;
}

export function actorOf(s: WebSession): Actor {
  return { tenantId: s.tenantId, type: 'user', id: s.userId };
}

/** Run under the tenant's RLS context — the only way the dashboard touches tenant data. */
export async function inTenant<T>(s: WebSession, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(db(), s.tenantId, fn);
}
