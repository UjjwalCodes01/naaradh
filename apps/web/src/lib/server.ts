import { Redis } from 'ioredis';
import { createDb, type Db } from '@naaradh/db';
import { memoryMailer, postmarkMailer, type Mailer } from '@naaradh/notify';
import { createLogger, systemClock, type Logger } from '@naaradh/shared';
import { env } from './env';
import { devMediaStore, gcsMediaStore, type MediaStore } from './media';

/**
 * Process-wide clients, created on first use (never at import, so `next build` needs no
 * database) and kept on globalThis so dev hot reloads do not leak pools.
 */
interface Clients {
  db: Db;
  redis: Redis;
  mailer: Mailer;
  media: MediaStore;
  log: Logger;
}

const g = globalThis as typeof globalThis & { __naaradhWeb?: Clients };

function clients(): Clients {
  if (g.__naaradhWeb !== undefined) return g.__naaradhWeb;
  const e = env();
  // JSON logs everywhere: pino-pretty's worker transport does not survive Next's bundling.
  const log = createLogger({ service: 'web', level: e.LOG_LEVEL });
  const created: Clients = {
    db: createDb({ url: e.DATABASE_URL, max: 5, applicationName: 'naaradh-web' }).db,
    redis: new Redis(e.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }),
    mailer:
      e.POSTMARK_TOKEN === undefined
        ? memoryMailer()
        : postmarkMailer({ serverToken: e.POSTMARK_TOKEN, from: e.MAIL_FROM }),
    media:
      (e.MEDIA_STORE ?? (e.NODE_ENV === 'production' ? 'gcs' : 'dev')) === 'gcs'
        ? gcsMediaStore()
        : devMediaStore(),
    log,
  };
  g.__naaradhWeb = created;
  return created;
}

export const db = (): Db => clients().db;
export const redis = (): Redis => clients().redis;
export const mailer = (): Mailer => clients().mailer;
export const media = (): MediaStore => clients().media;
export const log = (): Logger => clients().log;
export const now = (): Date => systemClock.now();
