import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { RoleClient, startTestPostgres, type TestPostgres } from '../../src/testing.js';

/**
 * Invariant 15 and the database-level guards from migration 0001, proven against a real
 * Postgres 16 as the roles the application actually uses.
 *
 * Every "must fail" case asserts on the error MESSAGE, because a test that only checks
 * "something threw" would pass on a typo.
 */

// Hashes stand in for HMAC output; they are hex-64 so the CHECK passes. Not PII.
const h = (s: string) => createHash('sha256').update(s).digest('hex');

const TENANT_A = newId('tenant');
const TENANT_B = newId('tenant');
const USECASE_A = newId('useCase');
const USECASE_B = newId('useCase');
const CONTACT_A = newId('contact');
const CONTACT_B = newId('contact');
const POOL_NUMBER = newId('number');

let pg: TestPostgres;
let owner: RoleClient;
let app: RoleClient;
let service: RoleClient;

beforeAll(async () => {
  pg = await startTestPostgres();
  owner = new RoleClient(pg.urls.migrator);
  app = new RoleClient(pg.urls.app);
  service = new RoleClient(pg.urls.service);

  // Fixtures via the service role — the only role that may create tenants.
  for (const [id, name] of [
    [TENANT_A, 'Tenant A'],
    [TENANT_B, 'Tenant B'],
  ] as const) {
    await service.query(
      `insert into tenants (id, name, country, data_region, status) values ($1, $2, 'IN', 'in', 'active')`,
      [id, name],
    );
  }
  await service.query(
    `insert into use_cases (id, tenant_id, kind, purpose, enabled) values ($1, $2, 'cod_confirm', 'transactional', true), ($3, $4, 'cod_confirm', 'transactional', true)`,
    [USECASE_A, TENANT_A, USECASE_B, TENANT_B],
  );
  await service.query(
    `insert into contacts (id, tenant_id, phone_hash, phone_masked, region) values ($1, $2, $3, '+91 60xxx xx001', 'IN'), ($4, $5, $6, '+91 60xxx xx002', 'IN')`,
    [CONTACT_A, TENANT_A, h(FAKE_IN.customer), CONTACT_B, TENANT_B, h(FAKE_IN.customerAlt)],
  );
  await service.query(
    `insert into numbers (id, tenant_id, e164, region, series, provider, engine, purpose_allowed, status)
     values ($1, null, $2, 'IN', '10digit', 'simulator', 'simulator', array['transactional']::purpose[], 'active')`,
    [POOL_NUMBER, FAKE_IN.merchant],
  );
}, 180_000);

afterAll(async () => {
  await Promise.all([owner.end(), app.end(), service.end()]);
  await pg.stop();
});

describe('tenant context is mandatory and loud', () => {
  it('raises when no context was ever set', async () => {
    await expect(app.query('select count(*) from contacts')).rejects.toThrow(
      /app\.tenant_id is not set/,
    );
  });

  it('raises after a previous transaction set a LOCAL context (pooled-connection case)', async () => {
    await app.inTenant(TENANT_A, async (c) => {
      await c.query('select count(*) from contacts');
    });
    // Same pool, next statement outside any tenant transaction.
    await expect(app.query('select count(*) from contacts')).rejects.toThrow(
      /app\.tenant_id is not set/,
    );
  });

  it('raises on a malformed tenant id', async () => {
    await expect(
      app.inTenant('not-a-tenant', (c) => c.query('select count(*) from contacts')),
    ).rejects.toThrow(/malformed/);
  });
});

describe('row isolation (invariant 15)', () => {
  it('shows a tenant only its own contacts', async () => {
    const rows = await app.inTenant(
      TENANT_A,
      async (c) => (await c.query<{ id: string }>('select id from contacts')).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([CONTACT_A]);
  });

  it('refuses to insert a row for another tenant even with the column set explicitly', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into contacts (id, tenant_id, phone_hash, phone_masked, region) values ($1, $2, $3, 'x', 'IN')`,
          [newId('contact'), TENANT_B, h('smuggled')],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('lets a tenant see and edit only its own tenants row', async () => {
    const names = await app.inTenant(
      TENANT_B,
      async (c) => (await c.query<{ name: string }>('select name from tenants')).rows,
    );
    expect(names).toEqual([{ name: 'Tenant B' }]);
    const updated = await app.inTenant(
      TENANT_A,
      async (c) =>
        (await c.query(`update tenants set name = 'Tenant A renamed' returning id`)).rowCount,
    );
    expect(updated).toBe(1);
    const other = await service.query('select name from tenants where id = $1', [TENANT_B]);
    expect(other.rows[0]?.['name']).toBe('Tenant B');
  });

  it('service role sees every tenant (cross-tenant scans) but stays grant-limited', async () => {
    const all = await service.query('select count(*)::int as n from contacts');
    expect(all.rows[0]?.['n']).toBe(2);
    await expect(service.query(`update consents set purpose = 'all'`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('global rows: suppressions, numbers, flags', () => {
  it('shows a GLOBAL suppression to every tenant, and a tenant one only to its owner', async () => {
    await service.query(
      `insert into suppressions (id, tenant_id, phone_hash, purpose, reason) values ($1, null, $2, 'all', 'self_service')`,
      [newId('suppression'), h('global-dnc')],
    );
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `insert into suppressions (id, tenant_id, phone_hash, purpose, reason) values ($1, $2, $3, 'promotional', 'opt_out')`,
        [newId('suppression'), TENANT_A, h('a-optout')],
      ),
    );
    const seenByB = await app.inTenant(
      TENANT_B,
      async (c) =>
        (await c.query<{ tenant_id: string | null }>('select tenant_id from suppressions')).rows,
    );
    expect(seenByB).toEqual([{ tenant_id: null }]);
    const seenByA = await app.inTenant(
      TENANT_A,
      async (c) =>
        (await c.query<{ n: number }>('select count(*)::int as n from suppressions')).rows,
    );
    expect(seenByA[0]?.n).toBe(2);
  });

  it('refuses a tenant creating a GLOBAL suppression', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into suppressions (id, tenant_id, phone_hash, purpose, reason) values ($1, null, $2, 'all', 'manual')`,
          [newId('suppression'), h('fake-global')],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('lets a tenant read pool numbers but not create numbers', async () => {
    const pool = await app.inTenant(
      TENANT_A,
      async (c) => (await c.query<{ id: string }>('select id from numbers')).rows,
    );
    expect(pool.map((r) => r.id)).toContain(POOL_NUMBER);
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into numbers (id, tenant_id, e164, region, series, provider, engine, purpose_allowed) values ($1, $2, $3, 'IN', '10digit', 'x', 'x', '{}')`,
          [newId('number'), TENANT_A, FAKE_IN.transferTarget],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('records pool-number use through touch_number() without an UPDATE grant', async () => {
    await app.inTenant(TENANT_A, (c) => c.query(`select touch_number($1, now())`, [POOL_NUMBER]));
    const row = await service.query('select last_used_at from numbers where id = $1', [
      POOL_NUMBER,
    ]);
    expect(row.rows[0]?.['last_used_at']).toBeInstanceOf(Date);
  });

  it('allows exactly one GLOBAL default per flag key (NULLS NOT DISTINCT)', async () => {
    await service.query(
      `insert into flags (tenant_id, key, value) values (null, 'dnd.scrub_transactional', 'true')`,
    );
    await expect(
      service.query(
        `insert into flags (tenant_id, key, value) values (null, 'dnd.scrub_transactional', 'false')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('append-only tables', () => {
  it('lets a tenant add a consent but never edit or delete one, at grant AND trigger level', async () => {
    const consentId = newId('consent');
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `insert into consents (id, tenant_id, phone_hash, purpose, source, recipient_region, captured_at) values ($1, $2, $3, 'promotional', 'checkout', 'IN', now())`,
        [consentId, TENANT_A, h(FAKE_IN.customer)],
      ),
    );
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update consents set purpose = 'all' where id = $1`, [consentId]),
      ),
    ).rejects.toThrow(/permission denied/);
    // Even the owner, with every grant, is stopped by the trigger.
    await expect(owner.query(`delete from consents where id = $1`, [consentId])).rejects.toThrow(
      /append-only/,
    );
  });

  it('refuses a revoke row without the grant it revokes', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into consents (id, tenant_id, phone_hash, action, purpose, source, recipient_region, captured_at) values ($1, $2, $3, 'revoke', 'promotional', 'verbal', 'IN', now())`,
          [newId('consent'), TENANT_A, h(FAKE_IN.customer)],
        ),
      ),
    ).rejects.toThrow(/consents_revoke_has_grant/);
  });
});

describe('column-level grants on tenants', () => {
  it('lets a merchant change settings but not their own status or billing state', async () => {
    await app.inTenant(TENANT_A, (c) =>
      c.query(`update tenants set settings = '{"digest":"daily"}'`),
    );
    await expect(
      app.inTenant(TENANT_A, (c) => c.query(`update tenants set status = 'active'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.inTenant(TENANT_A, (c) => c.query(`update tenants set billing_status = 'active'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.inTenant(TENANT_A, (c) => c.query(`update tenants set max_concurrency = 50`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('call_intents envelope guard (invariant 4)', () => {
  const intentId = newId('intent');

  beforeAll(async () => {
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source,
           external_ref, external_refs, event_ts, not_before, not_after, locale, idempotency_key)
         values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify',
           'order-1', array['order-1'], now(), now() + interval '2 minutes', now() + interval '30 minutes', 'hi-IN', $6)`,
        [
          intentId,
          TENANT_A,
          USECASE_A,
          CONTACT_A,
          h(FAKE_IN.customer),
          `shopify:test:order:1:cod_confirm`,
        ],
      ),
    );
  });

  it('refuses to extend not_after', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update call_intents set not_after = not_after + interval '1 hour' where id = $1`, [
          intentId,
        ]),
      ),
    ).rejects.toThrow(/may not be extended/);
  });

  it('allows shortening not_after (cancellation, window close)', async () => {
    const r = await app.inTenant(
      TENANT_A,
      async (c) =>
        (
          await c.query(
            `update call_intents set not_after = not_after - interval '5 minutes' where id = $1`,
            [intentId],
          )
        ).rowCount,
    );
    expect(r).toBe(1);
  });

  it('refuses to restart the 30-minute clock', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update call_intents set event_ts = now() where id = $1`, [intentId]),
      ),
    ).rejects.toThrow(/event_ts is immutable/);
  });

  it('refuses a duplicate idempotency key (E-52)', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source,
             external_ref, external_refs, event_ts, not_before, not_after, locale, idempotency_key)
           values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify',
             'order-1', array['order-1'], now(), now(), now() + interval '30 minutes', 'hi-IN', $6)`,
          [
            newId('intent'),
            TENANT_A,
            USECASE_A,
            CONTACT_A,
            h(FAKE_IN.customer),
            `shopify:test:order:1:cod_confirm`,
          ],
        ),
      ),
    ).rejects.toThrow(/call_intents_idempotency_uq/);
  });
});

describe('call_attempts and call_outcomes guards', () => {
  const intentId = newId('intent');
  const attemptId = newId('attempt');

  beforeAll(async () => {
    await app.inTenant(TENANT_A, async (c) => {
      await c.query(
        `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source,
           external_ref, external_refs, event_ts, not_before, not_after, locale, idempotency_key)
         values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify',
           'order-2', array['order-2'], now(), now(), now() + interval '30 minutes', 'hi-IN', $6)`,
        [
          intentId,
          TENANT_A,
          USECASE_A,
          CONTACT_A,
          h(FAKE_IN.customer),
          `shopify:test:order:2:cod_confirm`,
        ],
      );
      await c.query(
        `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, purpose, attempt_no, engine, from_e164, amd_mode, max_duration_sec, idempotency_key)
         values ($1, $2, $3, $4, $5, 'transactional', 1, 'simulator', $6, 'continue', 120, $7)`,
        [
          attemptId,
          TENANT_A,
          intentId,
          CONTACT_A,
          h(FAKE_IN.customer),
          FAKE_IN.merchant,
          `${intentId}:1`,
        ],
      );
    });
  });

  it('refuses an outbound attempt without an intent', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, purpose, attempt_no, engine, from_e164, amd_mode, max_duration_sec, idempotency_key)
           values ($1, $2, null, $3, $4, 'transactional', 1, 'simulator', $5, 'continue', 120, $6)`,
          [
            newId('attempt'),
            TENANT_A,
            CONTACT_A,
            h(FAKE_IN.customer),
            FAKE_IN.merchant,
            newId('attempt'),
          ],
        ),
      ),
    ).rejects.toThrow(/call_attempts_outbound_has_intent/);
  });

  it('refuses ENDED + human without both disclosures logged (invariant 7)', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `update call_attempts set status = 'ENDED', answered_by = 'human', ai_disclosed_at = now() where id = $1`,
          [attemptId],
        ),
      ),
    ).rejects.toThrow(/disclosures were not logged/);
    const r = await app.inTenant(
      TENANT_A,
      async (c) =>
        (
          await c.query(
            `update call_attempts set status = 'ENDED', answered_by = 'human', ai_disclosed_at = now(), recording_disclosed_at = now() where id = $1`,
            [attemptId],
          )
        ).rowCount,
    );
    expect(r).toBe(1);
  });

  it('refuses a billable row for a non-billable outcome (invariant 11)', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into call_outcomes (id, tenant_id, attempt_id, intent_id, outcome, confidence, extraction_method, billable, billable_reason)
           values ($1, $2, $3, $4, 'no_answer', 0.9, 'engine', true, 'x')`,
          [newId('outcome'), TENANT_A, attemptId, intentId],
        ),
      ),
    ).rejects.toThrow(/not billable/);
  });

  it('refuses a superseded outcome that is also billable (E-40)', async () => {
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(
          `insert into call_outcomes (id, tenant_id, attempt_id, intent_id, outcome, confidence, extraction_method, billable, billable_reason, superseded)
           values ($1, $2, $3, $4, 'confirmed', 0.9, 'engine', true, 'x', true)`,
          [newId('outcome'), TENANT_A, attemptId, intentId],
        ),
      ),
    ).rejects.toThrow(/superseded/);
  });

  it('freezes an outcome once billed (E-62: disputes credit, they do not edit)', async () => {
    const outcomeId = newId('outcome');
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `insert into call_outcomes (id, tenant_id, attempt_id, intent_id, outcome, confidence, extraction_method, billable, billable_reason, billed_at)
         values ($1, $2, $3, $4, 'confirmed', 0.95, 'engine', true, 'ok', now())`,
        [outcomeId, TENANT_A, attemptId, intentId],
      ),
    );
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update call_outcomes set outcome = 'cancelled' where id = $1`, [outcomeId]),
      ),
    ).rejects.toThrow(/frozen/);
  });

  it('refuses a transfer to an unverified target (toll-fraud guard)', async () => {
    const targetId = newId('transferTarget');
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `insert into transfer_targets (id, tenant_id, label, phone_hash, phone_enc, phone_enc_kid, phone_masked, region) values ($1, $2, 'Manager', $3, '\\x00', 1, '+91 60xxx xx101', 'IN')`,
        [targetId, TENANT_A, h(FAKE_IN.transferTarget)],
      ),
    );
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update call_attempts set transfer_target_id = $1 where id = $2`, [
          targetId,
          attemptId,
        ]),
      ),
    ).rejects.toThrow(/not a verified, active target/);
    await app.inTenant(TENANT_A, (c) =>
      c.query(`update transfer_targets set verified_at = now() where id = $1`, [targetId]),
    );
    const r = await app.inTenant(
      TENANT_A,
      async (c) =>
        (
          await c.query(`update call_attempts set transfer_target_id = $1 where id = $2`, [
            targetId,
            attemptId,
          ])
        ).rowCount,
    );
    expect(r).toBe(1);
  });
});

describe('scripts are immutable per version (universal rule 10)', () => {
  it('freezes body once approved and only allows retirement', async () => {
    const scriptId = newId('script');
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `insert into scripts (id, tenant_id, use_case_id, version, locale, body) values ($1, $2, $3, 1, 'hi-IN', '{"opening":"draft"}')`,
        [scriptId, TENANT_A, USECASE_A],
      ),
    );
    // drafts may change
    await app.inTenant(TENANT_A, (c) =>
      c.query(`update scripts set body = '{"opening":"v1"}' where id = $1`, [scriptId]),
    );
    // approval requires validation + approved_at (CHECK)
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update scripts set status = 'approved' where id = $1`, [scriptId]),
      ),
    ).rejects.toThrow(/scripts_approved_requires_validation/);
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `update scripts set status = 'approved', approved_at = now(), disclosure_validated_at = now() where id = $1`,
        [scriptId],
      ),
    );
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update scripts set body = '{"opening":"edited"}' where id = $1`, [scriptId]),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update scripts set status = 'draft' where id = $1`, [scriptId]),
      ),
    ).rejects.toThrow(/only be retired/);
    const retired = await app.inTenant(
      TENANT_A,
      async (c) =>
        (
          await c.query<{ retired_at: Date | null }>(
            `update scripts set status = 'retired' where id = $1 returning retired_at`,
            [scriptId],
          )
        ).rows[0],
    );
    expect(retired?.retired_at).toBeInstanceOf(Date);
  });
});

describe('suppressions may only be lifted', () => {
  it('refuses scope changes and lifts without an audit trail', async () => {
    const id = newId('suppression');
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `insert into suppressions (id, tenant_id, phone_hash, purpose, reason) values ($1, $2, $3, 'promotional', 'opt_out')`,
        [id, TENANT_A, h('lift-me')],
      ),
    );
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update suppressions set purpose = 'all' where id = $1`, [id]),
      ),
    ).rejects.toThrow(/only be lifted/);
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update suppressions set lifted_at = now() where id = $1`, [id]),
      ),
    ).rejects.toThrow(/requires lifted_by and lifted_reason/);
    await app.inTenant(TENANT_A, (c) =>
      c.query(
        `update suppressions set lifted_at = now(), lifted_by = 'usr_test', lifted_reason = 'customer asked' where id = $1`,
        [id],
      ),
    );
    await expect(
      app.inTenant(TENANT_A, (c) =>
        c.query(`update suppressions set lifted_at = null where id = $1`, [id]),
      ),
    ).rejects.toThrow(/cannot be re-armed/);
  });
});

describe('pre-context lookups', () => {
  it('resolves an API key to its tenant without a tenant context, as the app role', async () => {
    const keyId = newId('apiKey');
    const keyHash = h('nrd_live_testkey');
    await service.query(
      `insert into api_keys (id, tenant_id, name, kind, key_hash, prefix, scopes) values ($1, $2, 'test', 'secret', $3, 'nrd_live_tes', array['intents:create'])`,
      [keyId, TENANT_A, keyHash],
    );
    const r = await app.query('select * from resolve_tenant_by_api_key($1)', [keyHash]);
    expect(r.rows[0]).toMatchObject({
      tenant_id: TENANT_A,
      api_key_id: keyId,
      kind: 'secret',
      tenant_status: 'active',
    });
    const miss = await app.query('select * from resolve_tenant_by_api_key($1)', [h('nope')]);
    expect(miss.rowCount).toBe(0);
  });
});

describe('completeness: nothing tenant-scoped slips through a future migration', () => {
  it('every table with a tenant_id column has RLS enabled, forced, and at least one policy', async () => {
    const r = await owner.query<{
      table: string;
      enabled: boolean;
      forced: boolean;
      policies: number;
    }>(`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
      order by 1`);
    const bad = r.rows.filter((t) => !(t.enabled && t.forced && t.policies > 0));
    expect(bad, JSON.stringify(bad)).toEqual([]);
    // `tenants` has `id`, not `tenant_id`; check it explicitly.
    const tenants = await owner.query<{ enabled: boolean; forced: boolean }>(
      `select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where relname = 'tenants'`,
    );
    expect(tenants.rows[0]).toEqual({ enabled: true, forced: true });
  });

  it('every view runs with security_invoker (no owner-privilege bypass)', async () => {
    const r = await owner.query<{ view: string; options: string[] | null }>(`
      select c.relname as view, c.reloptions as options
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'`);
    for (const v of r.rows) {
      expect(v.options ?? [], v.view).toContain('security_invoker=true');
    }
  });

  it('the app role holds no BYPASSRLS and no DELETE on business tables', async () => {
    const role = await owner.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = 'naaradh_app'`,
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const deletes = await owner.query<{ table_name: string }>(`
      select table_name from information_schema.role_table_grants
      where grantee = 'naaradh_app' and privilege_type = 'DELETE'`);
    expect(deletes.rows).toEqual([]);
  });
});
