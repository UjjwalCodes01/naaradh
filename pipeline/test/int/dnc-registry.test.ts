import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@naaradh/db';
import { RoleClient, startTestPostgres, type TestPostgres } from '@naaradh/db/testing';
import { addDays } from '@naaradh/shared';
import { FAKE_UK, FAKE_US } from '@naaradh/shared/test/fake-phones';
import { registryDndProvider } from '@naaradh/compliance';
import { loadDncRegistry, type DncListSpec } from '../../src/dnc/registry.js';

/**
 * P6-CMP-1 — do-not-call registries loaded from their licensed files, screened by hash.
 * The cases that matter are the ones where a wrong answer calls someone who asked not to be:
 * a list that was never loaded, one that went stale, a subscription that does not cover the
 * number, a load that died half-way.
 */

const HASH_KEY = 'd'.repeat(32);
const NOW = new Date('2026-09-14T06:30:00Z');

let pg: TestPostgres;
let svc: Db;
let app: Db;
let closers: (() => Promise<void>)[] = [];
let appRole: RoleClient;

const US_NATIONAL: DncListSpec = {
  list: 'us_national',
  region: 'US',
  required: true,
  maxAgeDays: 31,
  areaCodes: null,
};

async function* lines(...ls: string[]): AsyncIterable<string> {
  for (const l of ls) yield l;
}

/** National format as the registry files carry it: "212,5550101" for +12125550101. */
const usLine = (e164: string) => `${e164.slice(2, 5)},${e164.slice(5)}`;
/** UK national format: 07700 900001 for +447700900001. */
const ukLine = (e164: string) => `0${e164.slice(3)}`;

const provider = (at: Date) => registryDndProvider(app, { hashKey: HASH_KEY, now: () => at });

beforeAll(async () => {
  pg = await startTestPostgres();
  const s = createDb({ url: pg.urls.service, max: 2 });
  const a = createDb({ url: pg.urls.app, max: 2 });
  svc = s.db;
  app = a.db;
  closers = [s.close, a.close];
  appRole = new RoleClient(pg.urls.app);
}, 180_000);

afterAll(async () => {
  for (const c of closers) await c();
  await appRole.end();
  await pg.stop();
});

describe('US National DNC Registry', () => {
  it('before any load, a US number cannot be screened: unknown, never "not registered"', async () => {
    expect(await provider(NOW).check(FAKE_US.customer, 'US')).toBe('unknown');
  });

  it('loads a file by hash, skipping headers and junk, and answers both ways', async () => {
    const result = await loadDncRegistry(svc, {
      spec: US_NATIONAL,
      version: 'v1',
      hashKey: HASH_KEY,
      lines: lines('AreaCode,PhoneNumber', usLine(FAKE_US.noWrittenConsent), 'not a number', ''),
      now: () => NOW,
    });
    expect(result).toMatchObject({ accepted: 1, rejected: 2, deleted: 0 });
    expect(await provider(NOW).check(FAKE_US.noWrittenConsent, 'US')).toBe('registered');
    expect(await provider(NOW).check(FAKE_US.customer, 'US')).toBe('not_registered');
  });

  it('freshness runs from the download date: an old download is refused, and ages from its own date', async () => {
    await expect(
      loadDncRegistry(svc, {
        spec: { ...US_NATIONAL, list: 'us_state_zz' },
        version: 'old',
        hashKey: HASH_KEY,
        lines: lines(usLine(FAKE_US.customer)),
        now: () => NOW,
        downloadedAt: new Date(NOW.getTime() - 40 * 86_400_000),
      }),
    ).rejects.toThrow(/more than 31 days ago/);
    await expect(
      loadDncRegistry(svc, {
        spec: { ...US_NATIONAL, list: 'us_state_zz' },
        version: 'future',
        hashKey: HASH_KEY,
        lines: lines(usLine(FAKE_US.customer)),
        now: () => NOW,
        downloadedAt: new Date(NOW.getTime() + 3 * 86_400_000),
      }),
    ).rejects.toThrow(/future/);
  });

  it('stores hashes only — no registry number is ever written in the clear (invariant 8)', async () => {
    const { rows } = await appRole.query<{ phone_hash: string }>(
      'select phone_hash from dnc_registry_entries',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.phone_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.phone_hash).not.toContain(FAKE_US.noWrittenConsent.slice(2));
    }
  });

  it('past 31 days the load is not trusted: unknown, and the gate refuses', async () => {
    const later = addDays(NOW, 32);
    expect(await provider(later).check(FAKE_US.noWrittenConsent, 'US')).toBe('unknown');
    expect(await provider(later).check(FAKE_US.customer, 'US')).toBe('unknown');
  });

  it('a new version replaces the old one, and a partial subscription answers only for its area codes', async () => {
    const result = await loadDncRegistry(svc, {
      spec: { ...US_NATIONAL, areaCodes: ['212'] },
      version: 'v2',
      hashKey: HASH_KEY,
      lines: lines(usLine(FAKE_US.customer), usLine(FAKE_US.hawaii)),
      now: () => NOW,
    });
    // The Hawaii line is outside the subscription the file claims: counted, not loaded.
    expect(result).toMatchObject({ accepted: 1, rejected: 1, deleted: 1 });
    expect(await provider(NOW).check(FAKE_US.customer, 'US')).toBe('registered');
    // Dropped from the registry between versions → no longer registered.
    expect(await provider(NOW).check(FAKE_US.noWrittenConsent, 'US')).toBe('not_registered');
    // 808 is not in the subscription: nobody screened it.
    expect(await provider(NOW).check(FAKE_US.hawaii, 'US')).toBe('unknown');
  });

  it('an empty file never replaces a list', async () => {
    await expect(
      loadDncRegistry(svc, {
        spec: { ...US_NATIONAL, areaCodes: ['212'] },
        version: 'v3',
        hashKey: HASH_KEY,
        lines: lines('header only'),
        now: () => NOW,
      }),
    ).rejects.toThrow(/no numbers/);
    expect(await provider(NOW).check(FAKE_US.customer, 'US')).toBe('registered');
  });

  it('a state list that went stale makes the whole region unknown, not silently skipped', async () => {
    await loadDncRegistry(svc, {
      spec: {
        list: 'us_state_tx',
        region: 'US',
        required: false,
        maxAgeDays: 31,
        areaCodes: ['212'],
      },
      version: 'tx1',
      hashKey: HASH_KEY,
      lines: lines(usLine(FAKE_US.transferTarget)),
      now: () => addDays(NOW, -40),
    });
    expect(await provider(NOW).check(FAKE_US.customer, 'US')).toBe('unknown');
    await loadDncRegistry(svc, {
      spec: {
        list: 'us_state_tx',
        region: 'US',
        required: false,
        maxAgeDays: 31,
        areaCodes: ['212'],
      },
      version: 'tx2',
      hashKey: HASH_KEY,
      lines: lines(usLine(FAKE_US.transferTarget)),
      now: () => NOW,
    });
    expect(await provider(NOW).check(FAKE_US.transferTarget, 'US')).toBe('registered');
    expect(await provider(NOW).check(FAKE_US.customer, 'US')).toBe('registered');
  });

  it("a state list's area codes mark its state only: they never make other numbers unknown", async () => {
    await loadDncRegistry(svc, {
      spec: {
        list: 'us_state_hi',
        region: 'US',
        required: false,
        maxAgeDays: 31,
        areaCodes: ['808'],
      },
      version: 'hi1',
      hashKey: HASH_KEY,
      lines: lines(usLine(FAKE_US.hawaii)),
      now: () => NOW,
    });
    // 212 is covered by the national subscription; the Hawaii list has nothing to say about it.
    expect(await provider(NOW).check(FAKE_US.customer, 'US')).toBe('registered');
    expect(await provider(NOW).check(FAKE_US.noWrittenConsent, 'US')).toBe('not_registered');
  });
});

describe('UK Telephone Preference Service', () => {
  it('unknown until TPS is loaded, then answered; a US list never answers for the UK', async () => {
    expect(await provider(NOW).check(FAKE_UK.customer, 'GB')).toBe('unknown');
    await loadDncRegistry(svc, {
      spec: { list: 'uk_tps', region: 'GB', required: true, maxAgeDays: 28, areaCodes: null },
      version: '2026-09-14',
      hashKey: HASH_KEY,
      lines: lines(ukLine(FAKE_UK.customer)),
      now: () => NOW,
    });
    expect(await provider(NOW).check(FAKE_UK.customer, 'GB')).toBe('registered');
    expect(await provider(NOW).check(FAKE_UK.transferTarget, 'GB')).toBe('not_registered');
    expect(await provider(addDays(NOW, 29)).check(FAKE_UK.customer, 'GB')).toBe('unknown');
  });

  it('a list name that does not match its region is refused before anything is written', async () => {
    await expect(
      loadDncRegistry(svc, {
        spec: { list: 'uk_tps', region: 'US', required: true, maxAgeDays: 28, areaCodes: null },
        version: 'x',
        hashKey: HASH_KEY,
        lines: lines(usLine(FAKE_US.customer)),
        now: () => NOW,
      }),
    ).rejects.toThrow(/does not belong/);
  });
});

describe('grants', () => {
  it('the app role reads the registry but can never write to it', async () => {
    await expect(
      appRole.query(
        "insert into dnc_registry_entries (phone_hash, list, version) values ('x', 'us_national', 'v9')",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appRole.query("update dnc_registry_lists set active_version = 'v9'"),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('grants: the region directory', () => {
  it('the app role reads the directory but cannot route anything anywhere', async () => {
    await expect(
      appRole.query(
        "insert into region_directory (kind, key, data_region, source) values ('shop', 'x.myshopify.com', 'us', 'in')",
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
