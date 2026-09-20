import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@naaradh/db';
import type { Actor, Role } from '@naaradh/pipeline';
import { authenticate } from '../shopify.server';
import { db } from './db.server';
import { provisionShop } from './provision.server';

/**
 * Every embedded request: a verified session token (App Bridge), the shop's tenant — resolved
 * from the integration row, never from anything the browser sends — and the actor for audit.
 *
 * Role: anyone Shopify lets open the app in this store's admin acts as the account owner here.
 * Shopify's staff permissions already decide who can open an app; finer roles live in the full
 * dashboard (app.naaradh.com), where people sign in individually (ADR-0009).
 */
export async function shopContext(request: Request) {
  const auth = await authenticate.admin(request);
  const { session } = auth;
  const r = await db().execute<{ tenant_id: string }>(
    sql`select tenant_id from resolve_tenant_by_integration('shopify'::integration_kind, ${session.shop})`,
  );
  const tenantId =
    r.rows[0]?.tenant_id ??
    (session.accessToken === undefined
      ? null
      : await provisionShop(session.shop, session.accessToken, session.scope));
  if (tenantId === null) throw new Response('Store not connected', { status: 401 });
  const sub = auth.sessionToken.sub;
  const actor: Actor = {
    tenantId,
    type: 'user',
    id: `shopify:${typeof sub === 'string' ? sub : session.shop}`,
  };
  const role: Role = 'owner';
  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db(), tenantId, fn);
  return { ...auth, tenantId, actor, role, inTenant };
}

export function formValue(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Response) throw error;
  if (
    error !== null &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  )
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join('; ');
  if (error instanceof Error && 'code' in error && (error as { code: unknown }).code !== 'INTERNAL')
    return error.message;
  console.error(error);
  return 'Something went wrong. Please try again.';
}
