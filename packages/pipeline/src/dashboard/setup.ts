import { and, eq } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import {
  ABANDONED_CART_DE_DE,
  ABANDONED_CART_EN_GB,
  ABANDONED_CART_EN_IN,
  ABANDONED_CART_EN_US,
  ABANDONED_CART_ES_ES,
  ABANDONED_CART_FR_FR,
  ABANDONED_CART_HI_IN,
  APPOINTMENT_CONFIRM_DE_DE,
  APPOINTMENT_CONFIRM_EN_GB,
  APPOINTMENT_CONFIRM_EN_US,
  APPOINTMENT_CONFIRM_ES_ES,
  APPOINTMENT_CONFIRM_FR_FR,
  COD_CONFIRM_EN_IN,
  COD_CONFIRM_HI_IN,
  FEEDBACK_EN_IN,
  FEEDBACK_HI_IN,
  type ScriptTemplate,
} from '@naaradh/scripts';
import { newId } from '@naaradh/shared';
import { audit } from '../audit.js';
import { auditActor, type Actor } from '../admin/actor.js';

/**
 * A new store's starting point (SPEC §8.4 steps 4–5): the use cases that suit its country, all
 * OFF, and draft scripts in its own language for the merchant to review and approve. India gets
 * COD confirmation, abandoned cart and feedback; elsewhere, where cash on delivery is rare, cart
 * recovery, feedback and appointment confirmation (PLAN Phase 6). Promotional use cases still
 * need consent capture, a DND scrub and (in India) DLT templates before they can be switched on
 * — ADR-0010. Idempotent: it only adds what is missing, so reinstalling changes nothing.
 */
/** The locales a new merchant can be set up in — every one with disclosure lines of its own. */
export type SetupLocale = 'hi-IN' | 'en-IN' | 'en-US' | 'en-GB' | 'de-DE' | 'fr-FR' | 'es-ES';

/**
 * The merchant's country decides the language its drafts are written in (ADR-0012 §3 makes the
 * region permanent, and the language follows the customers, not the merchant's convenience).
 * Anything unmapped gets US English, the widest common denominator outside India.
 */
export function setupLocaleFor(country: string): SetupLocale {
  const c = country.toUpperCase();
  if (c === 'IN') return 'hi-IN';
  if (c === 'GB' || c === 'IE') return 'en-GB';
  if (c === 'DE' || c === 'AT' || c === 'CH') return 'de-DE';
  if (c === 'FR' || c === 'BE') return 'fr-FR';
  if (c === 'ES' || c === 'MX' || c === 'AR' || c === 'CL' || c === 'CO') return 'es-ES';
  return 'en-US';
}

/** What Naaradh seeds per locale. India gets both its languages; elsewhere, one. */
const TEMPLATES_BY_LOCALE: Readonly<Record<SetupLocale, readonly ScriptTemplate[]>> = {
  'hi-IN': [
    COD_CONFIRM_HI_IN,
    COD_CONFIRM_EN_IN,
    ABANDONED_CART_HI_IN,
    ABANDONED_CART_EN_IN,
    FEEDBACK_HI_IN,
    FEEDBACK_EN_IN,
  ],
  'en-IN': [
    COD_CONFIRM_EN_IN,
    COD_CONFIRM_HI_IN,
    ABANDONED_CART_EN_IN,
    ABANDONED_CART_HI_IN,
    FEEDBACK_EN_IN,
    FEEDBACK_HI_IN,
  ],
  // Outside India, cash on delivery is rare: lead with cart recovery and appointments (PLAN P6).
  'en-US': [ABANDONED_CART_EN_US, APPOINTMENT_CONFIRM_EN_US],
  'en-GB': [ABANDONED_CART_EN_GB, APPOINTMENT_CONFIRM_EN_GB],
  'de-DE': [ABANDONED_CART_DE_DE, APPOINTMENT_CONFIRM_DE_DE],
  'fr-FR': [ABANDONED_CART_FR_FR, APPOINTMENT_CONFIRM_FR_FR],
  'es-ES': [ABANDONED_CART_ES_ES, APPOINTMENT_CONFIRM_ES_ES],
};

export async function ensureDefaultSetup(
  tx: Tx,
  actor: Actor,
  defaultLocale: SetupLocale = 'hi-IN',
): Promise<{ useCasesCreated: number; scriptsCreated: number }> {
  const existing = await tx
    .select({ id: schema.useCases.id, kind: schema.useCases.kind })
    .from(schema.useCases)
    .where(eq(schema.useCases.tenantId, actor.tenantId));
  const byKind = new Map(existing.map((u) => [u.kind, u.id]));
  let useCasesCreated = 0;
  const india = defaultLocale === 'hi-IN' || defaultLocale === 'en-IN';
  for (const [kind, purpose] of india
    ? ([
        ['cod_confirm', 'transactional'],
        ['abandoned_cart', 'promotional'],
        ['feedback', 'promotional'],
      ] as const)
    : ([
        ['abandoned_cart', 'promotional'],
        ['feedback', 'promotional'],
        ['appointment_confirm', 'service'],
      ] as const)) {
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
  for (const template of TEMPLATES_BY_LOCALE[defaultLocale]) {
    const useCaseId = byKind.get(
      template.use_case as 'cod_confirm' | 'abandoned_cart' | 'feedback' | 'appointment_confirm',
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
