import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { Storage } from '@google-cloud/storage';
import { z } from 'zod';
import { DNC_MAX_AGE_DAYS, REQUIRED_DNC_LISTS } from '@naaradh/compliance';
import { createServiceDb } from '@naaradh/db/service';
import { loadDncRegistry } from '@naaradh/pipeline';
import { baseEnv, createLogger, loadEnv, serviceDatabaseEnv } from '@naaradh/shared';

/**
 * `dnc-load` — load one national do-not-call registry file (P6-CMP-1; runbook
 * docs/runbooks/dnc-registry.md). Runs on the service role from a trusted machine or a Cloud Run
 * Job, like the key rotations. Prints counts only: the file holds real people's numbers and none
 * of them may reach a log (invariant 8).
 *
 *   DNC_LIST        us_national | us_state_<xx> | uk_tps | uk_ctps
 *   DNC_VERSION     the file's date or release id, e.g. 2026-09-19
 *   DNC_DOWNLOADED_AT  when it was downloaded from the registry — the 31/28-day clock starts here
 *   DNC_FILE        a local path or gs://bucket/object (the registry bucket, CMEK, no public read)
 *   DNC_AREA_CODES  US partial subscription only: "201,212,646"
 *
 * The US registry must be re-downloaded and loaded at least every 31 days, the UK TPS every 28;
 * past that, screening fails closed and every marketing call to that country is refused.
 */
const schema = z.object({
  ...baseEnv,
  ...serviceDatabaseEnv,
  PHONE_HASH_KEY: z.string().min(32),
  DNC_LIST: z.string().regex(/^(us_national|us_state_[a-z]{2}|uk_tps|uk_ctps)$/),
  DNC_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  /** When the file was downloaded from the registry (YYYY-MM-DD or ISO): freshness runs from it. */
  DNC_DOWNLOADED_AT: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'a date, e.g. 2026-09-19')
    .transform((v) => new Date(v)),
  DNC_FILE: z.string().min(1),
  DNC_AREA_CODES: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === '' ? null : v.split(',').map((a) => a.trim()),
    ),
});

const env = loadEnv(schema, process.env);
const log = createLogger({ service: 'maintenance:dnc-load', level: 'info' });
const region = env.DNC_LIST.startsWith('us_') ? 'US' : 'GB';

function open(file: string): Readable {
  const gs = /^gs:\/\/([^/]+)\/(.+)$/.exec(file);
  if (gs === null) return createReadStream(file);
  return new Storage()
    .bucket(gs[1] ?? '')
    .file(gs[2] ?? '')
    .createReadStream();
}

const service = createServiceDb({
  url: env.DATABASE_SERVICE_URL,
  applicationName: 'naaradh-dnc-load',
});
try {
  const lines = createInterface({ input: open(env.DNC_FILE), crlfDelay: Infinity });
  const result = await loadDncRegistry(service.db, {
    spec: {
      list: env.DNC_LIST,
      region,
      required: (REQUIRED_DNC_LISTS[region] ?? []).includes(env.DNC_LIST),
      maxAgeDays: DNC_MAX_AGE_DAYS[region] ?? 28,
      areaCodes: region === 'US' ? env.DNC_AREA_CODES : null,
    },
    version: env.DNC_VERSION,
    hashKey: env.PHONE_HASH_KEY,
    lines,
    now: () => new Date(),
    downloadedAt: env.DNC_DOWNLOADED_AT,
  });
  log.info(result, 'dnc-load: done');
  await service.close();
  process.exit(0);
} catch (error) {
  log.error({ err: error, list: env.DNC_LIST, version: env.DNC_VERSION }, 'dnc-load: failed');
  await service.close();
  process.exit(2);
}
