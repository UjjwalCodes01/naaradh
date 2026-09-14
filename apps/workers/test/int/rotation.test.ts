import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import {
  CUSTOMER_PHONE_COLUMNS,
  STAFF_PHONE_COLUMNS,
  loadShopifySession,
  rotateEncryptedPhoneColumn,
  rotateShopifySessions,
  storeShopifySession,
} from '@naaradh/pipeline';
import {
  decryptPhone,
  encryptPhone,
  generatePhoneKeyPair,
  hashPhone,
  maskPhone,
  newId,
} from '@naaradh/shared';
import { FAKE_IN } from '@naaradh/shared/test/fake-phones';

/**
 * Key rotation as re-encryption jobs (P3-INF-2, docs/runbooks/secret-rotation.md): Shopify
 * sessions re-sealed under a new AES key, customer and staff numbers re-encrypted under a new
 * RSA pair. Idempotent, partial failures counted and left alone, one audit row per run with
 * counts only.
 */

const T = newId('tenant');
const HASH_KEY = 'h'.repeat(32);
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const pair1 = generatePhoneKeyPair();
const pair2 = generatePhoneKeyPair();

let pg: TestPostgres;
let service: RoleClient;
let appDb: Db;
let svcDb: Db;
let closers: (() => Promise<void>)[] = [];

const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await service.query<R>(text, params)).rows;

const session = (n: number) => ({
  id: `offline_shop-${String(n)}.myshopify.com`,
  shop: `shop-${String(n)}.myshopify.com`,
  state: 'st',
  isOnline: false,
  scope: 'read_orders',
  expires: null,
  accessToken: `shpat_token_${String(n)}`,
  refreshToken: null,
  refreshTokenExpires: null,
  onlineAccessInfo: null,
});

beforeAll(async () => {
  pg = await startTestPostgres();
  service = new RoleClient(pg.urls.service);
  const a = createDb({ url: pg.urls.app, max: 2 });
  const s = createDb({ url: pg.urls.service, max: 2 });
  appDb = a.db;
  svcDb = s.db;
  closers = [a.close, s.close];
  await q(
    `insert into tenants (id, name, country, data_region) values ($1, 'Client A', 'IN', 'in')`,
    [T],
  );
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await service.end();
  await pg.stop();
});

describe('rotateShopifySessions', () => {
  it('re-seals rows under the new kid; both keys open them meanwhile; a corrupt row is counted, not fatal', async () => {
    for (let n = 1; n <= 4; n += 1)
      await storeShopifySession(appDb, { key: k1, kid: 1 }, session(n));
    const ring = new Map([
      [1, k1],
      [2, k2],
    ]);
    // Before: readable with the keyring that still has kid 1.
    expect((await loadShopifySession(appDb, ring, session(1).id))?.accessToken).toBe(
      'shpat_token_1',
    );
    // One row's tag is garbage: it can never be opened.
    await q(`update shopify_sessions set secret_tag = $1 where id = $2`, [
      randomBytes(16),
      session(4).id,
    ]);

    const first = await rotateShopifySessions(svcDb, ring, { key: k2, kid: 2 }, { batch: 2 });
    expect(first).toEqual({ rotated: 3, skipped: 0, failed: 1, remaining: 1 });
    const kids = await q<{ id: string; secret_kid: number }>(
      `select id, secret_kid from shopify_sessions order by id`,
    );
    expect(kids.map((r) => r.secret_kid)).toEqual([2, 2, 2, 1]);
    for (let n = 1; n <= 3; n += 1)
      expect(
        (await loadShopifySession(appDb, new Map([[2, k2]]), session(n).id))?.accessToken,
      ).toBe(`shpat_token_${String(n)}`);
    // Second run: nothing left but the corrupt row.
    expect(await rotateShopifySessions(svcDb, ring, { key: k2, kid: 2 })).toEqual({
      rotated: 0,
      skipped: 0,
      failed: 1,
      remaining: 1,
    });
    // Without the old key in the ring the corrupt row is failed for a different reason, same count.
    expect(
      await rotateShopifySessions(svcDb, new Map([[2, k2]]), { key: k2, kid: 2 }),
    ).toMatchObject({ rotated: 0, failed: 1 });
    await expect(
      rotateShopifySessions(svcDb, new Map([[1, k1]]), { key: k2, kid: 2 }),
    ).rejects.toThrow('keyring must contain the current key');
    const audits = await q<{ after: Record<string, unknown> }>(
      `select after from audit_log where action = 'key.rotated' and target_type = 'shopify_sessions' order by at`,
    );
    expect(audits.length).toBe(3);
    expect(audits[0]?.after).toMatchObject({ to_kid: 2, rotated: 3, failed: 1 });
    expect(JSON.stringify(audits)).not.toContain('shpat_');
  });
});

describe('rotateEncryptedPhoneColumn', () => {
  const contacts: string[] = [];
  const transfer = newId('transferTarget');
  const profile = newId('inboundProfile');

  beforeAll(async () => {
    for (const phone of [FAKE_IN.customer, FAKE_IN.customerAlt, FAKE_IN.optedOut]) {
      const id = newId('contact');
      contacts.push(id);
      const enc = encryptPhone(phone, pair1.publicKeyPem, 1);
      await q(
        `insert into contacts (id, tenant_id, phone_hash, phone_enc, phone_enc_kid, phone_masked, region)
         values ($1, $2, $3, $4, $5, $6, 'IN')`,
        [id, T, hashPhone(phone, HASH_KEY), enc.ciphertext, enc.kid, maskPhone(phone)],
      );
    }
    // A contact with no stored number (tombstoned) is left alone.
    await q(
      `insert into contacts (id, tenant_id, phone_hash, phone_enc, phone_enc_kid, phone_masked, region)
       values ($1, $2, $3, null, null, '+91 60xxx xx099', 'IN')`,
      [newId('contact'), T, hashPhone('+916000000099', HASH_KEY)],
    );
    const staff = encryptPhone(FAKE_IN.transferTarget, pair1.publicKeyPem, 1);
    await q(
      `insert into transfer_targets (id, tenant_id, label, phone_hash, phone_enc, phone_enc_kid, phone_masked, region, verified_at)
       values ($1, $2, 'Manager', $3, $4, 1, $5, 'IN', now())`,
      [
        transfer,
        T,
        hashPhone(FAKE_IN.transferTarget, HASH_KEY),
        staff.ciphertext,
        maskPhone(FAKE_IN.transferTarget),
      ],
    );
    const fallback = encryptPhone(FAKE_IN.merchant, pair1.publicKeyPem, 1);
    await q(
      `insert into inbound_profiles (id, tenant_id, name, greeting, business_hours, tools_enabled, pinned_facts, closed_message,
         fallback_forward_enc, fallback_forward_kid, fallback_forward_masked)
       values ($1, $2, 'Support', 'Namaste, main Client A ki taraf se automated AI assistant bol rahi hoon. Yeh call record ho rahi hai.',
         '{"zone":"Asia/Kolkata","days":[1,2,3,4,5],"open":"09:00","close":"18:00"}', array['lookup_order'], array[]::text[], 'Band hai.',
         $3, 1, $4)`,
      [profile, T, fallback.ciphertext, maskPhone(FAKE_IN.merchant)],
    );
  });

  it('customer numbers: decrypt with the old private key, encrypt with the new public key, bump the kid', async () => {
    const rotation = {
      fromKid: 1,
      fromPrivateKeyPem: pair1.privateKeyPem,
      toKid: 2,
      toPublicKeyPem: pair2.publicKeyPem,
    };
    const [column] = CUSTOMER_PHONE_COLUMNS;
    if (column === undefined) throw new Error('no customer columns');
    const r = await rotateEncryptedPhoneColumn(svcDb, column, rotation, { batch: 2 });
    expect(r).toEqual({ rotated: 3, skipped: 0, failed: 0, remaining: 0 });
    const rows = await q<{ id: string; phone_enc: Buffer; phone_enc_kid: number }>(
      `select id, phone_enc, phone_enc_kid from contacts where phone_enc is not null order by id`,
    );
    expect(rows.every((row) => row.phone_enc_kid === 2)).toBe(true);
    const decrypted = rows.map((row) => decryptPhone(row.phone_enc, pair2.privateKeyPem)).sort();
    expect(decrypted).toEqual([FAKE_IN.customer, FAKE_IN.customerAlt, FAKE_IN.optedOut].sort());
    // Idempotent.
    expect(await rotateEncryptedPhoneColumn(svcDb, column, rotation)).toEqual({
      rotated: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    await expect(
      rotateEncryptedPhoneColumn(svcDb, column, { ...rotation, toKid: 1 }),
    ).rejects.toThrow('from and to kid must differ');
    const audits = await q<{ after: Record<string, unknown>; actor_id: string }>(
      `select after, actor_id from audit_log where action = 'key.rotated' and target_type = 'contacts' order by at`,
    );
    expect(audits[0]?.after).toMatchObject({
      column: 'phone_enc',
      from_kid: 1,
      to_kid: 2,
      rotated: 3,
    });
    expect(JSON.stringify(audits)).not.toContain('6000000');
  });

  it('staff numbers: transfer targets and inbound fallback forwards, with a wrong-key row reported as failed', async () => {
    const wrong = generatePhoneKeyPair();
    // A second transfer target encrypted with a pair the job does not have.
    const bad = encryptPhone(FAKE_IN.transferTarget, wrong.publicKeyPem, 1);
    const badId = newId('transferTarget');
    await q(
      `insert into transfer_targets (id, tenant_id, label, phone_hash, phone_enc, phone_enc_kid, phone_masked, region)
       values ($1, $2, 'Old', $3, $4, 1, $5, 'IN')`,
      [
        badId,
        T,
        hashPhone(FAKE_IN.transferTarget, HASH_KEY),
        bad.ciphertext,
        maskPhone(FAKE_IN.transferTarget),
      ],
    );
    const rotation = {
      fromKid: 1,
      fromPrivateKeyPem: pair1.privateKeyPem,
      toKid: 2,
      toPublicKeyPem: pair2.publicKeyPem,
    };
    const results = [];
    for (const column of STAFF_PHONE_COLUMNS)
      results.push(await rotateEncryptedPhoneColumn(svcDb, column, rotation));
    expect(results).toEqual([
      { rotated: 1, skipped: 0, failed: 1, remaining: 1 },
      { rotated: 1, skipped: 0, failed: 0, remaining: 0 },
    ]);
    const [t] = await q<{ phone_enc: Buffer; phone_enc_kid: number }>(
      `select phone_enc, phone_enc_kid from transfer_targets where id = $1`,
      [transfer],
    );
    expect(t?.phone_enc_kid).toBe(2);
    expect(decryptPhone(t?.phone_enc ?? Buffer.alloc(0), pair2.privateKeyPem)).toBe(
      FAKE_IN.transferTarget,
    );
    const [p] = await q<{ fallback_forward_enc: Buffer; fallback_forward_kid: number }>(
      `select fallback_forward_enc, fallback_forward_kid from inbound_profiles where id = $1`,
      [profile],
    );
    expect(p?.fallback_forward_kid).toBe(2);
    expect(decryptPhone(p?.fallback_forward_enc ?? Buffer.alloc(0), pair2.privateKeyPem)).toBe(
      FAKE_IN.merchant,
    );
    // The unreadable row is untouched, still on kid 1, for a human to look at.
    const [b] = await q<{ phone_enc_kid: number }>(
      `select phone_enc_kid from transfer_targets where id = $1`,
      [badId],
    );
    expect(b?.phone_enc_kid).toBe(1);
  });
});
