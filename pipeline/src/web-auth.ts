import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@naaradh/db';
import { newId, sha256Hex } from '@naaradh/shared';

/**
 * Merchant dashboard sign-in (ADR-0009): magic links, sessions as opaque cookies. Only hashes
 * are stored; the browser holds the secret. Everything here runs before a tenant is known, so
 * it calls the SECURITY DEFINER functions from migration 0009 — never the service role.
 *
 * Callers are responsible for rate limits (per email and per IP) and for answering the browser
 * identically whether or not an account exists.
 */

export const LOGIN_TOKEN_TTL_MIN = 15;
export const SESSION_ABSOLUTE_DAYS = 7;
export const SESSION_IDLE_SECONDS = 12 * 60 * 60;

const SECRET = /^[A-Za-z0-9_-]{43}$/;

function secret(): string {
  return randomBytes(32).toString('base64url');
}

export const Email = z.string().trim().toLowerCase().email().max(254);

export interface LoginLink {
  readonly userId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  /** Raw token — goes into the emailed link and nowhere else. */
  readonly token: string;
}

/** One link per account the email belongs to; an empty list for strangers. */
export async function issueLoginLinks(
  db: Db,
  input: { readonly email: string; readonly ipHash: string | null; readonly now: Date },
): Promise<LoginLink[]> {
  const email = Email.safeParse(input.email);
  if (!email.success) return [];
  const candidates = await db.execute<{ user_id: string; tenant_id: string; tenant_name: string }>(
    sql`select * from web_login_candidates(${email.data})`,
  );
  const expires = new Date(input.now.getTime() + LOGIN_TOKEN_TTL_MIN * 60_000);
  const links: LoginLink[] = [];
  for (const c of candidates.rows) {
    const token = secret();
    const r = await db.execute<{ ok: boolean }>(
      sql`select create_login_token(${newId('loginToken')}, ${c.user_id}, ${sha256Hex(token)}, ${expires}, ${input.ipHash}, ${input.now}) as ok`,
    );
    if (r.rows[0]?.ok === true)
      links.push({ userId: c.user_id, tenantId: c.tenant_id, tenantName: c.tenant_name, token });
  }
  return links;
}

export interface OpenedSession {
  /** Raw session secret — the cookie value. */
  readonly sessionToken: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly expiresAt: Date;
}

/** Spend a login token (single use, 15 minutes) and open a session. Null when it is not valid. */
export async function consumeLoginToken(
  db: Db,
  input: {
    readonly token: string;
    readonly userAgent: string | null;
    readonly ipHash: string | null;
    readonly now: Date;
  },
): Promise<OpenedSession | null> {
  if (!SECRET.test(input.token)) return null;
  const sessionToken = secret();
  const sessionId = newId('webSession');
  const expiresAt = new Date(input.now.getTime() + SESSION_ABSOLUTE_DAYS * 86_400_000);
  const r = await db.execute<{ session_id: string; user_id: string; tenant_id: string }>(
    sql`select * from consume_login_token(${sha256Hex(input.token)}, ${sessionId}, ${sha256Hex(sessionToken)}, ${expiresAt}, ${input.userAgent ?? ''}, ${input.ipHash}, ${newId('audit')}, ${input.now})`,
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    sessionToken,
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    expiresAt,
  };
}

export type WebRole = 'viewer' | 'operator' | 'manager' | 'owner';

export interface WebSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly role: WebRole;
  readonly email: string;
  readonly name: string | null;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly expiresAt: Date;
}

export async function resolveWebSession(
  db: Db,
  sessionToken: string | undefined,
  now: Date,
): Promise<WebSession | null> {
  if (sessionToken === undefined || !SECRET.test(sessionToken)) return null;
  const r = await db.execute<{
    session_id: string;
    user_id: string;
    tenant_id: string;
    role: WebRole;
    email: string;
    name: string | null;
    tenant_name: string;
    tenant_status: string;
    expires_at: Date | string;
  }>(
    sql`select * from resolve_web_session(${sha256Hex(sessionToken)}, ${now}, ${SESSION_IDLE_SECONDS})`,
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    role: row.role,
    email: row.email,
    name: row.name,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
    expiresAt: new Date(row.expires_at),
  };
}
