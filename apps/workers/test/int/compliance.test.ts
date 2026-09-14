import { memoryMailer } from '@naaradh/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createDb, withTenant } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { resolveComplaint, resumeTenant } from '@naaradh/compliance';
import { upsertOrder } from '@naaradh/pipeline';
import { addDays, createLogger, generatePhoneKeyPair, hashPhone, newId } from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';
import { EngineRegistry } from '@naaradh/engines-registry';
import { runComplaintsOnce } from '../../src/complaints/index.js';
import type { WorkerContext } from '../../src/context.js';
import { inlineSecretResolver } from '../../src/deliveries/secrets.js';
import { runErasuresOnce, runRetentionOnce } from '../../src/retention/index.js';
import { runNotificationsOnce } from '../../src/notifications/index.js';
import { MailRetryableError, type Mailer, type Message } from '@naaradh/notify';
import { memoryRecordingStore } from '../../src/results/recordings.js';
import { recordingWriteback } from '../../src/results/writeback.js';

/**
 * Phase 2 compliance workers on real Postgres (RLS roles) + Redis: complaint attribution and
 * auto-pause (E-05), erasure across tenants (DPDP / Shopify redact), retention (P2-CMP-4).
 */

const TA = newId('tenant');
const TB = newId('tenant');
const HASH_KEY = 'h'.repeat(32);
const keyPair = generatePhoneKeyPair();
const current = new Date('2026-09-14T06:30:00Z');
const clock = { now: () => new Date(current.getTime()) };

let pg: TestPostgres;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let service: RoleClient;
let ctx: WorkerContext;
let recordings: ReturnType<typeof memoryRecordingStore>;
let closers: (() => Promise<void>)[] = [];
const useCase: Record<string, string> = {};

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;
const h = (e164: string) => hashPhone(e164, HASH_KEY);

/** An ended outbound call from `tenant` to `phone`, with a recording, a transcript and free-text extraction. */
async function callTo(
  tenant: string,
  phone: string,
  opts: { at?: Date; endedDaysAgo?: number } = {},
) {
  const at = opts.at ?? clock.now();
  const contactId = (
    await q<{ id: string }>(
      `insert into contacts (id, tenant_id, phone_hash, phone_enc, phone_enc_kid, phone_masked, region, name)
       values ($1, $2, $3, '\\x00', 1, '+91 60xxx xx001', 'IN', 'Asha Test')
       on conflict (tenant_id, phone_hash) do update set name = excluded.name returning id`,
      [newId('contact'), tenant, h(phone)],
    )
  )[0]?.id;
  const intentId = newId('intent');
  const ref = `ord-${intentId.slice(-6)}`;
  await q(
    `insert into call_intents (id, tenant_id, use_case_id, use_case, purpose, contact_id, phone_hash, recipient_region, source, external_ref, external_refs,
       event_ts, not_before, not_after, status, locale, idempotency_key, variables, created_at)
     values ($1, $2, $3, 'cod_confirm', 'transactional', $4, $5, 'IN', 'shopify', $6, array[$6], $7, $7, $7::timestamptz + interval '30 minutes', 'COMPLETED', 'hi-IN', $8,
       '{"customer_name":"Asha Test","order_ref":"#1001","pincode":"110001"}', $7)`,
    [intentId, tenant, useCase[tenant], contactId, h(phone), ref, at, `idem-${intentId}`],
  );
  const attemptId = newId('attempt');
  const ended = opts.endedDaysAgo === undefined ? at : addDays(clock.now(), -opts.endedDaysAgo);
  const rec = await recordings.persistRecording(
    tenant,
    attemptId,
    'https://engine.invalid/rec.mp3',
  );
  const tr = await recordings.persistTranscript(tenant, attemptId, [
    { role: 'customer', text: 'my address is flat 2' },
  ]);
  await q(
    `insert into call_attempts (id, tenant_id, intent_id, contact_id, phone_hash, direction, purpose, attempt_no, engine, from_e164, amd_mode, max_duration_sec,
       idempotency_key, status, ended_at, recording_uri, transcript_uri, created_at)
     values ($1, $2, $3, $4, $5, 'outbound', 'transactional', 1, 'simulator', $6, 'continue', 120, $1, 'ENDED', $7, $8, $9, $10)`,
    [attemptId, tenant, intentId, contactId, h(phone), FAKE_IN.merchant, ended, rec, tr, at],
  );
  await q(
    `insert into call_outcomes (id, tenant_id, attempt_id, intent_id, outcome, confidence, extracted, extraction_method, billable, billable_reason)
     values ($1, $2, $3, $4, 'confirmed_with_changes', 0.95, $5, 'engine', false, 'test')`,
    [
      newId('outcome'),
      tenant,
      attemptId,
      intentId,
      JSON.stringify({
        outcome: 'confirmed_with_changes',
        confidence: 0.95,
        address_change: 'Flat 2, New Road',
        notes: 'asked for Asha',
      }),
    ],
  );
  return { attemptId, contactId: contactId ?? '', intentId, rec, tr };
}

beforeAll(async () => {
  pg = await startTestPostgres();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  service = new RoleClient(pg.urls.service);
  for (const [id, name, days] of [
    [TA, 'Client A', 30],
    [TB, 'Client B', 90],
  ] as const) {
    await q(
      `insert into tenants (id, name, country, data_region, status, billing_status, retention_days) values ($1, $2, 'IN', 'in', 'active', 'active', $3)`,
      [id, name, days],
    );
    const uc = newId('useCase');
    useCase[id] = uc;
    await q(
      `insert into use_cases (id, tenant_id, kind, purpose, enabled) values ($1, $2, 'cod_confirm', 'transactional', true)`,
      [uc, id],
    );
  }
  const a = createDb({ url: pg.urls.app, max: 3 });
  const s = createDb({ url: pg.urls.service, max: 3 });
  closers = [a.close, s.close];
  recordings = memoryRecordingStore();
  ctx = {
    app: a.db,
    service: s.db,
    redis,
    registry: new EngineRegistry({
      env: {
        ENGINE_DEFAULT_IN: 'simulator',
        ENGINE_DEFAULT_US: 'simulator',
        SIMULATOR_WEBHOOK_SECRET: 'x'.repeat(20),
      },
    }),
    log: createLogger({ service: 'compliance-int', level: 'silent' }),
    clock,
    keys: {
      hashKey: HASH_KEY,
      encPublicKeyPem: keyPair.publicKeyPem,
      encKid: 1,
      privateKeyPem: keyPair.privateKeyPem,
    },
    gate: {
      engines: {
        defaultIn: 'simulator',
        defaultUs: 'simulator',
        secondaryIn: null,
        secondaryUs: null,
        maxConcurrency: { simulator: 20 },
      },
      engineDailyCapPaise: { simulator: 50_000_00 },
      globalDailyCapPaise: 200_000_00,
    },
    hooksBaseUrl: 'http://hooks.test',
    voiceBaseUrl: 'http://voice.test',
    engineWebhookKey: 'k'.repeat(32),
    recordings,
    shopify: recordingWriteback(),
    secrets: inlineSecretResolver(),
    shopifyAdmin: { apiVersion: '2026-07' },
    razorpay: null,
    mailer: memoryMailer(),
    dashboardUrl: 'https://app.naaradh.test',
    workerId: 'compliance-int',
    dispatchBatch: 10,
  };
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await service.end();
  redis.disconnect();
  await redisContainer.stop();
  await pg.stop();
});

const report = (phone: string, tenant: string | null, source = 'self_service') =>
  q(
    `insert into complaint_reports (id, tenant_id, phone_hash, source, reporter, reported_at) values ($1, $2, $3, $4, 'test', $5)`,
    [newId('complaintReport'), tenant, h(phone), source, clock.now()],
  );

describe('complaints worker (E-05)', () => {
  it('complaints.attributed_to_the_tenant_that_called — the most recent outbound caller in 30 days is blamed, the number suppressed globally', async () => {
    await callTo(TB, FAKE_IN.customerAlt, { at: addDays(clock.now(), -5) });
    await callTo(TA, FAKE_IN.customerAlt, { at: addDays(clock.now(), -1) });
    await report(FAKE_IN.customerAlt, null);
    expect(await runComplaintsOnce(ctx)).toMatchObject({ processed: 1, recorded: 1 });
    const [c] = await q<{ tenant_id: string; attempt_id: string | null }>(
      `select tenant_id, attempt_id from complaints where phone_hash = $1`,
      [h(FAKE_IN.customerAlt)],
    );
    expect(c?.tenant_id).toBe(TA);
    expect(c?.attempt_id).toMatch(/^att_/);
    const sup = await q(
      `select 1 from suppressions where tenant_id is null and phone_hash = $1 and reason = 'complaint'`,
      [h(FAKE_IN.customerAlt)],
    );
    expect(sup).toHaveLength(1);
    const events = await q<{ event_type: string }>(
      `select event_type from merchant_webhook_deliveries where tenant_id = $1`,
      [TA],
    );
    // No endpoint registered in this suite → no delivery rows, but the audit trail exists.
    expect(events).toEqual([]);
    expect(
      await q(`select 1 from audit_log where action = 'complaint.recorded' and tenant_id = $1`, [
        TA,
      ]),
    ).toHaveLength(1);
  });

  it('complaints.never_blame_a_tenant_that_did_not_call — no call in the window → unattributed, nobody counted, number still suppressed', async () => {
    await report(FAKE_IN.dnd, null);
    expect(await runComplaintsOnce(ctx)).toMatchObject({
      processed: 1,
      unattributed: 1,
      recorded: 0,
    });
    expect(
      await q(`select 1 from complaints where phone_hash = $1`, [h(FAKE_IN.dnd)]),
    ).toHaveLength(0);
    expect(
      await q(`select 1 from suppressions where tenant_id is null and phone_hash = $1`, [
        h(FAKE_IN.dnd),
      ]),
    ).toHaveLength(1);
  });

  it('complaints.tenant_pause_at_three — the third complaint in 10 days pauses the tenant; invalidating does not auto-resume', async () => {
    for (const phone of [FAKE_IN.optedOut, FAKE_IN.minorAnswered]) {
      await callTo(TA, phone);
      await report(phone, null);
    }
    const r = await runComplaintsOnce(ctx);
    expect(r).toMatchObject({ recorded: 2, tenantsPaused: 1 });
    const [t] = await q<{ status: string; paused_reason: string }>(
      `select status, paused_reason from tenants where id = $1`,
      [TA],
    );
    expect(t).toEqual({ status: 'paused', paused_reason: 'complaints:3_in_10d' });
    expect(
      await q(`select 1 from audit_log where action = 'tenant.auto_paused' and tenant_id = $1`, [
        TA,
      ]),
    ).toHaveLength(1);

    const [first] = await q<{ id: string }>(
      `select id from complaints where tenant_id = $1 order by received_at limit 1`,
      [TA],
    );
    await ctx.service.transaction((tx) =>
      resolveComplaint(tx, {
        complaintId: first?.id ?? '',
        status: 'invalid',
        by: 'staff@naaradh.test',
        notes: 'spoofed CLI',
        at: clock.now(),
      }),
    );
    expect(
      (await q<{ status: string }>(`select status from tenants where id = $1`, [TA]))[0]?.status,
    ).toBe('paused');
    await expect(
      ctx.service.transaction((tx) =>
        resumeTenant(tx, { tenantId: TA, by: 'staff', reason: 'ok', at: clock.now() }),
      ),
    ).rejects.toThrow(/reason/);
    expect(
      await ctx.service.transaction((tx) =>
        resumeTenant(tx, {
          tenantId: TA,
          by: 'staff@naaradh.test',
          reason: 'first complaint was a spoofed CLI, verified with TSP',
          at: clock.now(),
        }),
      ),
    ).toBe(true);
    expect(
      (await q<{ status: string }>(`select status from tenants where id = $1`, [TA]))[0]?.status,
    ).toBe('active');
  });

  it('a report is processed exactly once, even when two workers race', async () => {
    await callTo(TB, FAKE_IN.customer);
    await report(FAKE_IN.customer, TB, 'merchant');
    const [a, b] = await Promise.all([runComplaintsOnce(ctx), runComplaintsOnce(ctx)]);
    expect(a.recorded + b.recorded).toBe(1);
    expect(
      await q(`select 1 from complaints where tenant_id = $1 and phone_hash = $2`, [
        TB,
        h(FAKE_IN.customer),
      ]),
    ).toHaveLength(1);
  });
});

describe('erasure worker (DPDP, Shopify customers/redact)', () => {
  it('erasure.scrubs_every_tenant_holding_the_number — media deleted, contact tombstoned, free text gone, legal record kept', async () => {
    const phone = FAKE_IN.transferTarget;
    const a = await callTo(TA, phone);
    const b = await callTo(TB, phone);
    await withTenant(ctx.app, TA, (tx) =>
      upsertOrder(tx, HASH_KEY, {
        tenantId: TA,
        source: 'shopify',
        externalId: '9900',
        name: '#9900',
        rawPhone: phone,
        defaultRegion: 'IN',
        pincode: '110001',
        paymentKind: 'cod',
        financialStatus: null,
        fulfillmentStatus: null,
        cancelledAt: null,
        totalMinor: 100,
        currency: 'INR',
        itemSummary: '1 × Kurta',
        itemCount: 1,
        placedAt: clock.now(),
        sourceUpdatedAt: clock.now(),
      }),
    );
    await q(
      `insert into support_tickets (id, tenant_id, contact_id, category, summary, source) values ($1, $2, $3, 'address_change', 'New address: Flat 2, New Road', 'agent')`,
      [newId('ticket'), TA, a.contactId],
    );
    await q(
      `insert into suppressions (id, tenant_id, phone_hash, purpose, reason, created_by) values ($1, $2, $3, 'all', 'opt_out', 'test')`,
      [newId('suppression'), TA, h(phone)],
    );
    // A tool call whose arguments are the caller's own words (an address) — audit 2026-09-14.
    const actionId = newId('agentAction');
    await q(
      `insert into agent_actions (id, tenant_id, attempt_id, tool, args, status, result)
       values ($1, $2, $3, 'request_address_change', '{"order_ref":"#1001","new_address_summary":"Flat 2, New Road, near the temple"}', 'ticketed', '{"ok":true,"data":{"address_change":"requested"}}')`,
      [actionId, TA, a.attemptId],
    );
    for (const uri of [a.rec, a.tr, b.rec, b.tr]) expect(recordings.objects.has(uri)).toBe(true);

    const erasureId = newId('erasure');
    await q(
      `insert into erasure_requests (id, tenant_id, phone_hash, source, due_at) values ($1, null, $2, 'email', $3)`,
      [erasureId, h(phone), addDays(clock.now(), 30)],
    );
    expect(await runErasuresOnce(ctx)).toMatchObject({ completed: 1, failed: 0 });

    const contacts = await q<{
      name: string | null;
      phone_enc: Buffer | null;
      erased_at: Date | null;
      phone_masked: string;
    }>(`select name, phone_enc, erased_at, phone_masked from contacts where phone_hash = $1`, [
      h(phone),
    ]);
    expect(contacts).toHaveLength(2);
    for (const c of contacts)
      expect(c).toMatchObject({ name: null, phone_enc: null, phone_masked: 'erased' });
    const attempts = await q<{
      recording_uri: string | null;
      transcript_uri: string | null;
      media_purged_at: Date | null;
    }>(
      `select recording_uri, transcript_uri, media_purged_at from call_attempts where phone_hash = $1`,
      [h(phone)],
    );
    for (const at of attempts)
      expect(at).toMatchObject({ recording_uri: null, transcript_uri: null });
    for (const uri of [a.rec, a.tr, b.rec, b.tr]) expect(recordings.objects.has(uri)).toBe(false);
    const outcomes = await q<{ extracted: Record<string, unknown> }>(
      `select o.extracted from call_outcomes o join call_attempts a on a.id = o.attempt_id where a.phone_hash = $1`,
      [h(phone)],
    );
    for (const o of outcomes)
      expect(o.extracted).toEqual({ outcome: 'confirmed_with_changes', confidence: 0.95 });
    const intents = await q<{ variables: Record<string, unknown> }>(
      `select variables from call_intents where phone_hash = $1`,
      [h(phone)],
    );
    for (const i of intents) expect(i.variables).toEqual({ order_ref: '#1001' });
    expect(
      (
        await q<{ phone_hash: string | null; erased_at: Date | null }>(
          `select phone_hash, erased_at from orders where external_id = '9900'`,
        )
      )[0],
    ).toMatchObject({ phone_hash: null });
    expect(
      (
        await q<{ summary: string }>(`select summary from support_tickets where contact_id = $1`, [
          a.contactId,
        ])
      )[0]?.summary,
    ).toBe('[erased]');
    expect(
      (
        await q<{ args: unknown; result: unknown }>(
          `select args, result from agent_actions where id = $1`,
          [actionId],
        )
      )[0],
    ).toEqual({ args: { erased: true }, result: { erased: true } });
    // The legal record stays.
    expect(
      await q(`select 1 from suppressions where phone_hash = $1 and lifted_at is null`, [h(phone)]),
    ).toHaveLength(1);
    const [done] = await q<{
      status: string;
      report: { tenants: Record<string, { contacts: number; mediaObjects: number }> };
    }>(`select status, report from erasure_requests where id = $1`, [erasureId]);
    expect(done?.status).toBe('completed');
    expect(Object.keys(done?.report.tenants ?? {}).sort()).toEqual([TA, TB].sort());
    expect(done?.report.tenants[TA]).toMatchObject({ contacts: 1, mediaObjects: 2 });
  });

  it('erasure is idempotent and an erased contact is never refilled by a later order', async () => {
    const phone = FAKE_IN.transferTarget;
    await q(
      `insert into erasure_requests (id, tenant_id, phone_hash, source, due_at) values ($1, $2, $3, 'api', $4)`,
      [newId('erasure'), TA, h(phone), addDays(clock.now(), 30)],
    );
    expect(await runErasuresOnce(ctx)).toMatchObject({ completed: 1 });
    const [c] = await q<{ name: string | null }>(
      `select name from contacts where tenant_id = $1 and phone_hash = $2`,
      [TA, h(phone)],
    );
    expect(c?.name).toBeNull();
  });

  it('an overdue request is reported, never silently skipped', async () => {
    // Claimed by a live worker a moment ago (updated_at = now), so not stale — just late.
    await q(
      `insert into erasure_requests (id, tenant_id, phone_hash, source, due_at, status, started_at, updated_at) values ($1, $2, $3, 'api', $4, 'in_progress', $5, $5)`,
      [newId('erasure'), TA, h(FAKE_IN.customer), addDays(clock.now(), -1), clock.now()],
    );
    expect((await runErasuresOnce(ctx)).overdue).toBeGreaterThanOrEqual(1);
  });
});

describe('retention sweep (P2-CMP-4)', () => {
  it('retention.purges_media_past_the_tenant_setting — per tenant, by end time; order cache minimised', async () => {
    const old = await callTo(TA, FAKE_IN.customer, { endedDaysAgo: 31 });
    const fresh = await callTo(TA, FAKE_IN.customer, { endedDaysAgo: 5 });
    const bOld = await callTo(TB, FAKE_IN.customer, { endedDaysAgo: 31 }); // TB keeps 90 days
    await withTenant(ctx.app, TA, (tx) =>
      upsertOrder(tx, HASH_KEY, {
        tenantId: TA,
        source: 'shopify',
        externalId: '8800',
        name: '#8800',
        rawPhone: FAKE_IN.customer,
        defaultRegion: 'IN',
        pincode: '110001',
        paymentKind: 'cod',
        financialStatus: null,
        fulfillmentStatus: null,
        cancelledAt: null,
        totalMinor: 100,
        currency: 'INR',
        itemSummary: 'x',
        itemCount: 1,
        placedAt: addDays(clock.now(), -200),
        sourceUpdatedAt: addDays(clock.now(), -200),
      }),
    );
    const r = await runRetentionOnce(ctx);
    expect(r.mediaPurged).toBeGreaterThanOrEqual(1);
    expect(r.ordersErased).toBeGreaterThanOrEqual(1);
    const state = async (id: string) =>
      (
        await q<{ recording_uri: string | null; media_purged_at: Date | null }>(
          `select recording_uri, media_purged_at from call_attempts where id = $1`,
          [id],
        )
      )[0];
    expect(await state(old.attemptId)).toMatchObject({ recording_uri: null });
    expect((await state(old.attemptId))?.media_purged_at).not.toBeNull();
    expect((await state(fresh.attemptId))?.recording_uri).not.toBeNull();
    expect((await state(bOld.attemptId))?.recording_uri).not.toBeNull();
    expect(recordings.objects.has(old.rec)).toBe(false);
    expect(recordings.objects.has(fresh.rec)).toBe(true);
    expect(recordings.objects.has(bOld.rec)).toBe(true);
    expect(
      (
        await q<{ erased_at: Date | null }>(
          `select erased_at from orders where external_id = '8800'`,
        )
      )[0]?.erased_at,
    ).not.toBeNull();
    // A second sweep has nothing left to do for these rows.
    expect((await runRetentionOnce(ctx)).mediaPurged).toBe(0);
  });
});

describe('merchant notifications (P2-WEB-4)', () => {
  const sentTo = (m: Mailer) => (m as Mailer & { sent: Message[] }).sent;

  it('complaint and pause alerts email the owners and managers of the tenant, once', async () => {
    await q(
      `insert into users (id, tenant_id, email, role) values ($1, $3, 'owner@ta.example', 'owner'), ($2, $3, 'viewer@ta.example', 'viewer')
       on conflict do nothing`,
      [newId('user'), newId('user'), TA],
    );
    const queued = await q<{ kind: string; status: string }>(
      `select kind, status from merchant_notifications where tenant_id = $1 and kind <> 'daily_summary'`,
      [TA],
    );
    // The complaints tests above emitted complaint.received (and tenant.paused on the third).
    expect(queued.map((n) => n.kind)).toContain('complaint.received');
    expect(queued.map((n) => n.kind)).toContain('tenant.paused');
    const before = sentTo(ctx.mailer).length;
    const r = await runNotificationsOnce(ctx);
    expect(r.sent).toBeGreaterThanOrEqual(2);
    const mails = sentTo(ctx.mailer).slice(before);
    expect(new Set(mails.map((m) => m.to))).toEqual(new Set(['owner@ta.example']));
    expect(mails.some((m) => m.subject.startsWith('Calling is paused'))).toBe(true);
    for (const m of mails) expect(m.text).not.toMatch(/\+91/);
    // Nothing left to send; a second pass sends nothing.
    const again = await runNotificationsOnce(ctx);
    expect(again.sent).toBe(0);
  });

  it('the daily summary is queued once per local day after 09:00 and skipped when nothing happened', async () => {
    const at = new Date('2026-09-20T03:40:00Z'); // 09:10 IST
    const c = { ...ctx, clock: { now: () => at } };
    const r1 = await runNotificationsOnce(c);
    const r2 = await runNotificationsOnce(c);
    expect(r1.queued).toBeGreaterThanOrEqual(1);
    expect(r2.queued).toBe(0);
    const rows = await q<{ tenant_id: string; event_id: string }>(
      `select tenant_id, event_id from merchant_notifications where kind = 'daily_summary' and event_id = '2026-09-20'`,
    );
    expect(new Set(rows.map((x) => x.tenant_id)).size).toBe(rows.length);
    const early = { ...ctx, clock: { now: () => new Date('2026-09-21T02:00:00Z') } }; // 07:30 IST
    expect((await runNotificationsOnce(early)).queued).toBe(0);
  });

  it('a Postmark outage is retried with backoff, not lost', async () => {
    const failing: Mailer = {
      send: async () => {
        throw new MailRetryableError('Postmark HTTP 503');
      },
    };
    await q(
      `insert into merchant_notifications (id, tenant_id, kind, event_id, data, next_attempt_at) values ($1, $2, 'billing.capped', 'cap-1', '{}', $3)`,
      [newId('notification'), TA, clock.now()],
    );
    const r = await runNotificationsOnce({ ...ctx, mailer: failing });
    expect(r.retried).toBe(1);
    const [row] = await q<{ status: string; attempts: number; next_attempt_at: Date }>(
      `select status, attempts, next_attempt_at from merchant_notifications where event_id = 'cap-1'`,
    );
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row?.next_attempt_at.getTime()).toBeGreaterThan(clock.now().getTime());
    const later = { ...ctx, clock: { now: () => new Date(clock.now().getTime() + 3 * 60_000) } };
    expect((await runNotificationsOnce(later)).sent).toBe(1);
  });
});
