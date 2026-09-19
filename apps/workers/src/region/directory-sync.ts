import {
  applyDirectorySnapshot,
  localDirectoryEntries,
  type DirectorySnapshot,
} from '@naaradh/pipeline';
import { signRegionSnapshot } from '@naaradh/shared';
import type { WorkerContext } from '../context.js';
import { runLoop } from '../loop.js';

/**
 * Region directory sync (ADR-0012 §4, P6-INF-2). Every few minutes this deployment derives the
 * shops and numbers it serves from its own tables, writes them to its own directory, and pushes
 * the same snapshot to each peer's hooks (`POST /internal/region-directory`, signed with
 * this region's Ed25519 key, REGION_SYNC_PRIVATE_KEY). The snapshot is a full list, so an uninstalled shop disappears from every
 * directory on the next pass. No personal data: domains, our own numbers, a region.
 *
 * A peer that is down is retried on the next pass; its directory is only stale, and a stale
 * entry costs one webhook acknowledged-and-ignored by the wrong region (E-144), never a
 * misdelivery of data.
 */

export interface DirectorySyncConfig {
  readonly region: 'in' | 'us' | 'eu';
  readonly peers: Readonly<Partial<Record<'in' | 'us' | 'eu', string>>>;
  /** REGION_SYNC_PRIVATE_KEY; null → nothing is pushed (single region). */
  readonly privateKey: string | null;
  readonly fetchImpl?: typeof fetch;
}

export interface DirectorySyncReport {
  readonly entries: number;
  readonly local: { upserted: number; removed: number; conflicts: number };
  readonly pushed: Record<string, number | 'failed'>;
}

export async function syncRegionDirectoryOnce(
  ctx: WorkerContext,
  cfg: DirectorySyncConfig,
): Promise<DirectorySyncReport> {
  const entries = await localDirectoryEntries(ctx.service, cfg.region);
  const snapshot: DirectorySnapshot = {
    source: cfg.region,
    generated_at: ctx.clock.now().toISOString(),
    entries,
  };
  const local = await ctx.service.transaction((tx) => applyDirectorySnapshot(tx, snapshot));
  const pushed: Record<string, number | 'failed'> = {};
  if (cfg.privateKey !== null) {
    const body = JSON.stringify(snapshot);
    const signature = signRegionSnapshot(
      cfg.privateKey,
      body,
      Math.floor(ctx.clock.now().getTime() / 1000),
    );
    for (const [region, base] of Object.entries(cfg.peers)) {
      if (region === cfg.region) continue;
      try {
        const res = await (cfg.fetchImpl ?? fetch)(
          new URL('/internal/region-directory', base).href,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-naaradh-region': cfg.region,
              'x-naaradh-signature': signature,
            },
            body,
            signal: AbortSignal.timeout(15_000),
          },
        );
        pushed[region] = res.status;
        if (!res.ok) ctx.log.warn({ peer: region, status: res.status }, 'directory push refused');
      } catch (error) {
        pushed[region] = 'failed';
        ctx.log.warn(
          { peer: region, err: error instanceof Error ? error.name : 'unknown' },
          'directory push failed',
        );
      }
    }
  }
  return { entries: entries.length, local, pushed };
}

export async function runRegionDirectorySync(
  ctx: WorkerContext,
  cfg: DirectorySyncConfig,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await runLoop({
    name: 'region-directory',
    log: ctx.log,
    intervalMs,
    signal,
    async tick() {
      const r = await syncRegionDirectoryOnce(ctx, cfg);
      if (
        r.local.upserted + r.local.removed + r.local.conflicts > 0 ||
        Object.keys(r.pushed).length > 0
      )
        ctx.log.info(r, 'region directory synced');
    },
  });
}
