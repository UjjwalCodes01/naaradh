import { Redis } from 'ioredis';
import { createDb } from '@naaradh/db';
import { calendarRegistry } from '@naaradh/calendar';
import { concurrencyPort, killSwitchPort } from '@naaradh/compliance';
import { EngineRegistry } from '@naaradh/engines-registry';
import { systemClock } from '@naaradh/shared';
import { loadVoiceEnv } from './env.js';
import { inlineSecretReader, secretManagerReader } from './secrets.js';
import { buildServer } from './server.js';

const env = loadVoiceEnv();

const { db, close } = createDb({ url: env.DATABASE_URL, applicationName: 'naaradh-voice' });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
// Reconnects are handled by ioredis; logged so an outage is visible, never fatal.
redis.on('error', (error) => {
  process.stderr.write(
    `${JSON.stringify({ severity: 'WARNING', message: 'redis client error', error: error.message })}\n`,
  );
});
const registry = new EngineRegistry({ env });

const app = await buildServer({
  db,
  redis,
  registry,
  clock: systemClock,
  keys: {
    hashKey: env.PHONE_HASH_KEY,
    encPublicKeyPem: env.PHONE_ENC_PUBLIC_KEY,
    encKid: env.PHONE_ENC_KID,
    staffPrivateKeyPem: env.STAFF_ENC_PRIVATE_KEY,
  },
  engineWebhookKey: env.ENGINE_WEBHOOK_KEY,
  voiceBaseUrl: env.VOICE_BASE_URL,
  hooksBaseUrl: env.HOOKS_BASE_URL,
  engineMaxConcurrency: env.ENGINE_MAX_CONCURRENCY,
  killSwitches: killSwitchPort(redis),
  concurrency: concurrencyPort(redis),
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  // ADR-0011: the appointment tools. Without a connected calendar they refuse politely and
  // the agent offers a callback — never a made-up time.
  calendars: calendarRegistry({ now: () => systemClock.now() }),
  secrets: env.NODE_ENV === 'production' ? secretManagerReader() : inlineSecretReader(),
  logLevel: env.LOG_LEVEL,
  trustProxyHops: env.TRUST_PROXY_HOPS,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  redis.disconnect();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
