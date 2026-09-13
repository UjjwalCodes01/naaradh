import type { Redis } from 'ioredis';
import type { Db } from '@naaradh/db';
import type { ConcurrencyPort, KillSwitchPort } from '@naaradh/compliance';
import type { EngineRegistry } from '@naaradh/engines-registry';
import type { Clock } from '@naaradh/shared';

/**
 * Everything the voice runtime needs, built once at startup (index.ts) or by a test. The
 * kill-switch port is built ONCE so its ≤5 s cache is shared across requests (invariant 12).
 */
export interface VoiceDeps {
  /** naaradh_app — RLS-bound. apps/voice never holds the service role. */
  readonly db: Db;
  readonly redis: Redis;
  readonly registry: EngineRegistry;
  readonly clock: Clock;
  readonly keys: {
    readonly hashKey: string;
    readonly encPublicKeyPem: string;
    readonly encKid: number;
    /** Staff key pair (invariant 19): opens transfer-target and fallback numbers only. */
    readonly staffPrivateKeyPem: string;
  };
  readonly engineWebhookKey: string;
  readonly voiceBaseUrl: string;
  readonly hooksBaseUrl: string;
  readonly engineMaxConcurrency: number;
  readonly killSwitches: KillSwitchPort;
  readonly concurrency: ConcurrencyPort;
  readonly rateLimitPerMinute: number;
  readonly logLevel?: string;
}
