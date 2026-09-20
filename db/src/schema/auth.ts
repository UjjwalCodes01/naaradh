import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, idFormat, ts, updatedAt } from './columns.js';
import { tenants, users } from './tenants.js';

/**
 * Merchant dashboard sign-in (ADR-0009). Magic links, no passwords: a login token is 32
 * random bytes emailed once; only its SHA-256 is stored, it lives 15 minutes and is spent
 * exactly once (consume_login_token()). A session cookie is the same shape — the browser
 * holds the secret, Postgres holds the hash.
 *
 * Both tables are tenant-scoped under RLS, but the sign-in path runs BEFORE a tenant is
 * known, so it goes through SECURITY DEFINER functions in migration 0009 rather than the
 * service role (the dashboard never holds BYPASSRLS).
 */
export const loginTokens = pgTable(
  'login_tokens',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    ipHash: text('ip_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    check('login_tokens_id_format', idFormat(t.id, 'ltk')),
    check('login_tokens_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('login_tokens_hash_uq').on(t.tokenHash),
    index('login_tokens_user_idx').on(t.userId, t.createdAt),
  ],
).enableRLS();

export const webSessions = pgTable(
  'web_sessions',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    sessionHash: text('session_hash').notNull(),
    /** Absolute lifetime; the idle timeout is enforced against last_seen_at. */
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    /** Truncated, for the "where you're signed in" list. Not an identifier. */
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    check('web_sessions_id_format', idFormat(t.id, 'wss')),
    check('web_sessions_hash_format', sql`${t.sessionHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'web_sessions_user_agent_len',
      sql`${t.userAgent} is null or char_length(${t.userAgent}) <= 200`,
    ),
    uniqueIndex('web_sessions_hash_uq').on(t.sessionHash),
    index('web_sessions_user_idx').on(t.userId, t.createdAt),
  ],
).enableRLS();

/**
 * Shopify app sessions (ADR-0007). The access token (and refresh token, when Shopify issues
 * expiring offline tokens) is sealed with AES-256-GCM under SHOPIFY_TOKEN_KEY; the row holds
 * ciphertext, IV and tag, bound to the session id as additional authenticated data so a
 * ciphertext cannot be moved to another shop's row. RLS is forced with NO policy: only the
 * SECURITY DEFINER functions (the Shopify app) and the service role (workers) reach it.
 */
export const shopifySessions = pgTable(
  'shopify_sessions',
  {
    /** Shopify's own session id: `offline_<shop>` or `<shop>_<userId>` for online sessions. */
    id: text('id').primaryKey(),
    shop: text('shop').notNull(),
    state: text('state').notNull().default(''),
    isOnline: boolean('is_online').notNull().default(false),
    scope: text('scope'),
    expiresAt: ts('expires_at'),
    secretCiphertext: bytea('secret_ciphertext').notNull(),
    secretIv: bytea('secret_iv').notNull(),
    secretTag: bytea('secret_tag').notNull(),
    /** Which SHOPIFY_TOKEN_KEY sealed it — rotation is a re-encryption job. */
    secretKid: smallint('secret_kid').notNull().default(1),
    /** Online sessions only: the staff member's Shopify user info (not customer data). */
    onlineAccessInfo: jsonb('online_access_info'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'shopify_sessions_shop_format',
      sql`${t.shop} ~ '^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$'`,
    ),
    index('shopify_sessions_shop_idx').on(t.shop),
  ],
).enableRLS();
