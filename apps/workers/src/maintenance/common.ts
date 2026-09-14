import { z } from 'zod';
import { createServiceDb } from '@naaradh/db/service';
import type { RotationCounts } from '@naaradh/pipeline';
import { baseEnv, createLogger, loadEnv, serviceDatabaseEnv } from '@naaradh/shared';

/**
 * One-shot maintenance processes (docs/runbooks/secret-rotation.md). Each entrypoint validates
 * its own environment, runs one job on the service role, prints counts (never a key, a token
 * or a number) and exits non-zero when any row failed. They ship in the workers image
 * (`node dist/rotate-….js`) and run from a trusted machine or a Cloud Run Job execution — never
 * as a long-running service, so no service ever holds two private keys at once (AGENTS §4).
 */

export const maintenanceEnv = {
  ...baseEnv,
  ...serviceDatabaseEnv,
  /** Rows per transaction. */
  ROTATION_BATCH: z.coerce.number().int().min(1).max(5000).default(500),
};

type MaintenanceSchema = z.ZodObject<typeof maintenanceEnv & z.ZodRawShape>;

export async function runMaintenance<S extends MaintenanceSchema>(
  name: string,
  schema: S,
  job: (env: z.infer<S>, db: ReturnType<typeof createServiceDb>['db']) => Promise<RotationCounts[]>,
): Promise<never> {
  const env = loadEnv(schema, process.env);
  const log = createLogger({ service: `maintenance:${name}`, level: 'info' });
  const { DATABASE_SERVICE_URL: url } = loadEnv(z.object(maintenanceEnv), process.env);
  const service = createServiceDb({ url, applicationName: `naaradh-${name}` });
  let failed = 0;
  try {
    const results = await job(env, service.db);
    for (const r of results) {
      log.info(r, `${name}: done`);
      failed += r.failed;
    }
  } catch (error) {
    log.error({ err: error }, `${name}: crashed`);
    await service.close();
    process.exit(2);
  }
  await service.close();
  if (failed > 0) {
    log.error({ failed }, `${name}: ${String(failed)} row(s) could not be rotated — see runbook`);
    process.exit(1);
  }
  process.exit(0);
}
