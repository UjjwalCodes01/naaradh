import { and, asc, desc, eq, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { inZone, paise, type Money } from '@naaradh/shared';
import { NaaradhError } from '@naaradh/shared';
import type {
  AttemptPort,
  ConsentPort,
  ContactSnapshot,
  FlagPort,
  GateInput,
  IntentSnapshot,
  NumberPort,
  ScriptPort,
  SuppressionPort,
  TenantSnapshot,
} from '../gate/types.js';

/**
 * Postgres implementations of the gate's read ports. Every function takes the tenant-scoped
 * transaction (`withTenant`), so RLS is what scopes the rows; the explicit tenant_id
 * predicates are belt-and-braces and documentation, not the isolation mechanism.
 */

export function suppressionPort(tx: Tx): SuppressionPort {
  return {
    async findActive(tenantId, phoneHash, now) {
      const rows = await tx
        .select({
          id: schema.suppressions.id,
          tenantId: schema.suppressions.tenantId,
          purpose: schema.suppressions.purpose,
          reason: schema.suppressions.reason,
          externalRef: schema.suppressions.externalRef,
          until: schema.suppressions.until,
        })
        .from(schema.suppressions)
        .where(
          and(
            eq(schema.suppressions.phoneHash, phoneHash),
            isNull(schema.suppressions.liftedAt),
            or(isNull(schema.suppressions.until), gt(schema.suppressions.until, now)),
            or(isNull(schema.suppressions.tenantId), eq(schema.suppressions.tenantId, tenantId)),
          ),
        );
      return rows.map((r) => ({
        id: r.id,
        scope: r.tenantId === null ? 'global' : 'tenant',
        purpose: r.purpose,
        reason: r.reason,
        externalRef: r.externalRef,
        until: r.until,
      }));
    },
  };
}

export function consentPort(tx: Tx): ConsentPort {
  return {
    async findGrants(tenantId, phoneHash, purposes) {
      const revokes = tx
        .select({ one: sql`1` })
        .from(sql`${schema.consents} as r`)
        .where(sql`r.action = 'revoke' and r.grant_id = ${schema.consents.id}`);
      const rows = await tx
        .select({
          id: schema.consents.id,
          purpose: schema.consents.purpose,
          source: schema.consents.source,
          capturedAt: schema.consents.capturedAt,
          expiresAt: schema.consents.expiresAt,
        })
        .from(schema.consents)
        .where(
          and(
            eq(schema.consents.tenantId, tenantId),
            eq(schema.consents.phoneHash, phoneHash),
            eq(schema.consents.action, 'grant'),
            inArray(schema.consents.purpose, [...purposes]),
            notExists(revokes),
          ),
        )
        .orderBy(desc(schema.consents.capturedAt));
      return rows;
    },
  };
}

export function attemptPort(tx: Tx): AttemptPort {
  return {
    async history(tenantId, phoneHash, purpose, externalRef) {
      return tx
        .select({
          id: schema.callAttempts.id,
          status: schema.callAttempts.status,
          dispatchedAt: schema.callAttempts.dispatchedAt,
          endedAt: schema.callAttempts.endedAt,
        })
        .from(schema.callAttempts)
        .where(
          and(
            eq(schema.callAttempts.tenantId, tenantId),
            eq(schema.callAttempts.phoneHash, phoneHash),
            eq(schema.callAttempts.purpose, purpose),
            eq(schema.callAttempts.externalRef, externalRef),
          ),
        )
        .orderBy(asc(schema.callAttempts.dispatchedAt));
    },
  };
}

export function numberPort(tx: Tx): NumberPort {
  return {
    async candidates(tenantId, region, engine) {
      // RLS shows pool rows (tenant_id NULL) plus this tenant's own. Own first, then the
      // least recently used, so the pool rotates (E-28).
      const rows = await tx
        .select({
          id: schema.numbers.id,
          e164: schema.numbers.e164,
          region: schema.numbers.region,
          engine: schema.numbers.engine,
          purposeAllowed: schema.numbers.purposeAllowed,
          status: schema.numbers.status,
          answerRate7d: schema.numbers.answerRate7d,
          tenantId: schema.numbers.tenantId,
        })
        .from(schema.numbers)
        .where(
          and(
            eq(schema.numbers.region, region),
            eq(schema.numbers.engine, engine),
            eq(schema.numbers.status, 'active'),
          ),
        )
        .orderBy(
          sql`case when ${schema.numbers.tenantId} = ${tenantId} then 0 else 1 end`,
          sql`${schema.numbers.lastUsedAt} asc nulls first`,
        );
      return rows.map((r) => ({
        id: r.id,
        e164: r.e164,
        region: r.region,
        engine: r.engine,
        purposeAllowed: r.purposeAllowed,
        status: r.status,
        answerRate7d: r.answerRate7d === null ? null : Number(r.answerRate7d),
        ownedByTenant: r.tenantId === tenantId,
      }));
    },
  };
}

export function scriptPort(tx: Tx): ScriptPort {
  return {
    async approved(tenantId, useCaseId, locale) {
      const [row] = await tx
        .select({
          id: schema.scripts.id,
          version: schema.scripts.version,
          locale: schema.scripts.locale,
          dltTemplateId: schema.scripts.dltTemplateId,
        })
        .from(schema.scripts)
        .where(
          and(
            eq(schema.scripts.tenantId, tenantId),
            eq(schema.scripts.useCaseId, useCaseId),
            eq(schema.scripts.locale, locale),
            eq(schema.scripts.status, 'approved'),
          ),
        )
        .orderBy(desc(schema.scripts.version))
        .limit(1);
      return row ?? null;
    },
  };
}

export function flagPort(tx: Tx): FlagPort {
  return {
    async get<T>(tenantId: string, key: string, fallback: T): Promise<T> {
      const rows = await tx
        .select({ tenantId: schema.flags.tenantId, value: schema.flags.value })
        .from(schema.flags)
        .where(
          and(
            eq(schema.flags.key, key),
            or(isNull(schema.flags.tenantId), eq(schema.flags.tenantId, tenantId)),
          ),
        );
      const tenantRow = rows.find((r) => r.tenantId === tenantId);
      const globalRow = rows.find((r) => r.tenantId === null);
      const chosen = tenantRow ?? globalRow;
      return chosen === undefined ? fallback : (chosen.value as T);
    },
  };
}

/**
 * Tenant spend from the attempts table, in the TENANT's zone's calendar day/month (the cap
 * is the merchant's budget, so the merchant's day). Engine/global spend live in Redis.
 */
export function tenantSpend(tx: Tx, tenantZone: string, now: Date) {
  const sumSince = async (tenantId: string, since: Date): Promise<Money> => {
    const [row] = await tx
      .select({
        total: sql<string>`coalesce(sum(coalesce(${schema.callAttempts.costPaiseEngine},0) + coalesce(${schema.callAttempts.costPaiseTelephony},0)), 0)`,
      })
      .from(schema.callAttempts)
      .where(
        and(eq(schema.callAttempts.tenantId, tenantId), gt(schema.callAttempts.createdAt, since)),
      );
    return paise(Number(row?.total ?? 0));
  };
  const local = inZone(now, tenantZone);
  const startOfDay = local.startOf('day').toJSDate();
  const startOfMonth = local.startOf('month').toJSDate();
  return {
    tenantSpentToday: (tenantId: string) => sumSince(tenantId, startOfDay),
    tenantSpentThisMonth: (tenantId: string) => sumSince(tenantId, startOfMonth),
  };
}

export interface LoadedGateInput extends Omit<GateInput, 'now'> {
  readonly tenantZone: string;
}

/** One round trip: intent + tenant + contact → the snapshots the gate needs. */
export async function loadGateInput(tx: Tx, intentId: string): Promise<LoadedGateInput> {
  const [row] = await tx
    .select({
      intent: schema.callIntents,
      tenant: schema.tenants,
      contact: schema.contacts,
    })
    .from(schema.callIntents)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.callIntents.tenantId))
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.callIntents.contactId))
    .where(eq(schema.callIntents.id, intentId))
    .limit(1);
  if (row === undefined)
    throw new NaaradhError('NOT_FOUND', 'intent not found', { context: { intent_id: intentId } });

  const t = row.tenant;
  const c = row.contact;
  const i = row.intent;

  const tenant: TenantSnapshot = {
    id: t.id,
    status: t.status,
    reviewUntil: t.reviewUntil,
    dltLinkedAt: t.dltLinkedAt,
    billingStatus: t.billingStatus,
    billingGraceUntil: t.billingGraceUntil,
    currency: t.currency,
    spendCapDailyPaise: t.spendCapDailyPaise,
    spendCapMonthlyPaise: t.spendCapMonthlyPaise,
    maxConcurrency: t.maxConcurrency,
    engineOverride: t.engineOverride,
    multiEngineOk: t.multiEngineOk,
    amdModeTransactional: t.amdModeTransactional,
    amdModePromotional: t.amdModePromotional,
  };
  const contact: ContactSnapshot = {
    id: c.id,
    hasPhone: c.phoneEnc !== null,
    phoneType: c.phoneType,
    phoneTypeCheckedAt: c.phoneTypeCheckedAt,
    timezone: c.timezone,
    skip: c.skip,
    erasedAt: c.erasedAt,
  };
  const intent: IntentSnapshot = {
    id: i.id,
    tenantId: i.tenantId,
    useCaseId: i.useCaseId,
    useCase: i.useCase,
    purpose: i.purpose,
    phoneHash: i.phoneHash,
    recipientRegion: i.recipientRegion,
    eventTs: i.eventTs,
    notBefore: i.notBefore,
    notAfter: i.notAfter,
    attemptsCount: i.attemptsCount,
    externalRef: i.externalRef,
    locale: i.locale,
    campaignId: i.campaignId,
  };
  return { tenant, contact, intent, tenantZone: t.timezone };
}
