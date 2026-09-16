import { and, eq } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import {
  ABANDONED_CART_EN_IN,
  ABANDONED_CART_HI_IN,
  COD_CONFIRM_EN_IN,
  COD_CONFIRM_HI_IN,
  FEEDBACK_EN_IN,
  FEEDBACK_HI_IN,
} from '@naaradh/scripts';
import { newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';

/**
 * A new store's starting point (SPEC §8.4 steps 4–5): the COD confirmation use case (OFF until
 * the merchant goes live), abandoned cart and post-delivery feedback (OFF — promotional, need
 * consent capture, a DND scrub and DLT templates, ADR-0010), and draft
 * scripts from the default templates for the merchant to review and approve. Idempotent: it only
 * adds what is missing, so reinstalling or re-running onboarding changes nothing.
 */
export async function ensureDefaultSetup(
  tx: Tx,
  actor: Actor,
  defaultLocale: 'hi-IN' | 'en-IN' = 'hi-IN',
): Promise<{ useCasesCreated: number; scriptsCreated: number }> {
  const existing = await tx
    .select({ id: schema.useCases.id, kind: schema.useCases.kind })
    .from(schema.useCases)
    .where(eq(schema.useCases.tenantId, actor.tenantId));
  const byKind = new Map(existing.map((u) => [u.kind, u.id]));
  let useCasesCreated = 0;
  for (const [kind, purpose] of [
    ['cod_confirm', 'transactional'],
    ['abandoned_cart', 'promotional'],
    ['feedback', 'promotional'],
  ] as const) {
    if (byKind.has(kind)) continue;
    const id = newId('useCase');
    await tx.insert(schema.useCases).values({
      id,
      tenantId: actor.tenantId,
      kind,
      purpose,
      enabled: false,
      config: { defaultLocale, minOrderValuePaise: 0, pilotPercent: 100 },
    });
    byKind.set(kind, id);
    useCasesCreated += 1;
  }
  let scriptsCreated = 0;
  for (const template of [
    COD_CONFIRM_HI_IN,
    COD_CONFIRM_EN_IN,
    ABANDONED_CART_HI_IN,
    ABANDONED_CART_EN_IN,
    FEEDBACK_HI_IN,
    FEEDBACK_EN_IN,
  ]) {
    const useCaseId = byKind.get(
      template.use_case as 'cod_confirm' | 'abandoned_cart' | 'feedback',
    );
    if (useCaseId === undefined) continue;
    const [has] = await tx
      .select({ id: schema.scripts.id })
      .from(schema.scripts)
      .where(
        and(
          eq(schema.scripts.tenantId, actor.tenantId),
          eq(schema.scripts.useCaseId, useCaseId),
          eq(schema.scripts.locale, template.locale),
        ),
      )
      .limit(1);
    if (has !== undefined) continue;
    await tx.insert(schema.scripts).values({
      id: newId('script'),
      tenantId: actor.tenantId,
      useCaseId,
      version: 1,
      locale: template.locale,
      body: template,
      status: 'draft',
    });
    scriptsCreated += 1;
  }
  if (useCasesCreated + scriptsCreated > 0)
    await audit(tx, {
      ...auditActor(actor),
      action: 'tenant.default_setup',
      targetType: 'tenant',
      targetId: actor.tenantId,
      after: { use_cases: useCasesCreated, scripts: scriptsCreated },
    });
  return { useCasesCreated, scriptsCreated };
}
