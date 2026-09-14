import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BigQuery } from '@google-cloud/bigquery';
import { NaaradhError } from '@naaradh/shared';
import type { DailyFact } from './facts.js';

/**
 * Where a day's facts go. `loadDay` REPLACES the day: loading the same day twice must leave
 * exactly one copy, and loading zero rows must leave the day empty — that is what makes the
 * export safe to re-run after a partial failure.
 */
export interface FactSink {
  loadDay(day: string, rows: readonly DailyFact[]): Promise<void>;
}

export interface BigQuerySinkOptions {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
  /** Dataset location (asia-south1). Jobs must run where the dataset lives. */
  readonly location?: string;
}

/** `daily_call_facts$20260913` — the partition decorator for a DAY-partitioned table. */
export function partitionDecorator(tableId: string, day: string): string {
  return `${tableId}$${day.replaceAll('-', '')}`;
}

export function toNdjson(rows: readonly DailyFact[]): string {
  return rows.map((r) => `${JSON.stringify(r)}\n`).join('');
}

/**
 * BigQuery load job into the day's partition with WRITE_TRUNCATE: the partition is replaced
 * atomically by the job, so a re-run never duplicates and an empty day truncates. Never the
 * streaming insert API — streamed rows cannot be replaced, and the buffer cannot be truncated.
 *
 * Needs `roles/bigquery.dataEditor` on the dataset and `roles/bigquery.jobUser` on the project
 * (load jobs), on the workers-analytics runtime identity.
 */
export function bigQuerySink(options: BigQuerySinkOptions): FactSink {
  const client = new BigQuery({
    projectId: options.projectId,
    ...(options.location === undefined ? {} : { location: options.location }),
  });
  const dataset = client.dataset(options.datasetId);
  return {
    async loadDay(day, rows) {
      const dir = await mkdtemp(join(tmpdir(), 'naaradh-facts-'));
      try {
        const file = join(dir, `${day}.ndjson`);
        await writeFile(file, toNdjson(rows), 'utf8');
        const [job] = await dataset.table(partitionDecorator(options.tableId, day)).load(file, {
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          writeDisposition: 'WRITE_TRUNCATE',
          createDisposition: 'CREATE_NEVER',
          jobPrefix: `naaradh_daily_call_facts_${day.replaceAll('-', '')}_`,
          ...(options.location === undefined ? {} : { location: options.location }),
        });
        const failure = job.status?.errorResult;
        if (failure !== undefined) {
          throw new NaaradhError('INTERNAL', 'analytics: BigQuery load job failed', {
            context: { day, reason: failure.reason ?? '', message: failure.message ?? '' },
            retryable: true,
          });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface MemorySink extends FactSink {
  /** day → the rows of the last load for that day. */
  readonly days: Map<string, DailyFact[]>;
  /** How many loads happened, for idempotency assertions. */
  loads: number;
}

/** Tests and `pnpm dev` without BigQuery: the same replace-the-day semantics, in memory. */
export function memorySink(): MemorySink {
  const days = new Map<string, DailyFact[]>();
  const sink: MemorySink = {
    days,
    loads: 0,
    async loadDay(day, rows) {
      days.set(
        day,
        rows.map((r) => ({ ...r })),
      );
      sink.loads += 1;
    },
  };
  return sink;
}
