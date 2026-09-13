import { Redis } from 'ioredis';
import { createServiceDb } from '@naaradh/db/service';
import { systemClock } from '@naaradh/shared';
import { loadConsoleEnv } from './env.js';
import { iapKeyFetcher, isStaff, verifyIapJwt } from './iap.js';
import { buildConsole } from './server.js';

const env = loadConsoleEnv();
const service = createServiceDb({
  url: env.DATABASE_SERVICE_URL,
  applicationName: 'naaradh-console',
});
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const keys = iapKeyFetcher();
const allowList = env.CONSOLE_STAFF_EMAILS.split(',')
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.length > 0);

const app = await buildConsole({
  db: service.db,
  redis,
  clock: () => systemClock.now(),
  hashKey: env.PHONE_HASH_KEY,
  origin: env.CONSOLE_ORIGIN,
  logLevel: env.LOG_LEVEL,
  async authenticate(request) {
    // Local development only (refused in production by the env schema).
    if (env.CONSOLE_DEV_STAFF_EMAIL !== undefined) return env.CONSOLE_DEV_STAFF_EMAIL;
    if (env.IAP_AUDIENCE === undefined) return null;
    const header = request.headers['x-goog-iap-jwt-assertion'];
    const id = await verifyIapJwt(
      typeof header === 'string' ? header : undefined,
      env.IAP_AUDIENCE,
      keys,
    ).catch(() => null);
    if (id === null || !isStaff(id.email, env.CONSOLE_ALLOWED_DOMAIN, allowList)) return null;
    return id.email;
  },
  readTranscript:
    env.RECORDINGS_BUCKET === undefined
      ? null
      : async (uri) => {
          const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
          if (m?.[1] === undefined || m[2] === undefined || m[1] !== env.RECORDINGS_BUCKET)
            return [];
          const { Storage } = await import('@google-cloud/storage');
          const [buf] = await new Storage().bucket(m[1]).file(m[2]).download();
          const turns = JSON.parse(buf.toString('utf8')) as unknown;
          return Array.isArray(turns)
            ? turns.flatMap((t: unknown) => {
                const o = t as { role?: unknown; text?: unknown };
                return typeof o.text === 'string'
                  ? [{ role: o.role === 'agent' ? 'agent' : 'customer', text: o.text }]
                  : [];
              })
            : [];
        },
});

await app.listen({ port: env.PORT, host: env.HOST });

const shutdown = async () => {
  await app.close();
  await service.close();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
