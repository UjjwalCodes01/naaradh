import { z } from 'zod';
import {
  baseEnv,
  databaseEnv,
  loadEnv,
  phoneEncryptEnv,
  phoneHashEnv,
  redisEnv,
  staffDecryptEnv,
} from '@naaradh/shared';
import { engineEnv, refineEngineEnv } from '@naaradh/engines-registry';

/**
 * apps/voice keys (ADR-0006, invariant 19):
 *   - customer PUBLIC key   — it creates contacts for callers, never reads a number back
 *   - STAFF private key     — it hands a verified manager's number to the engine at transfer time
 *   - customer PRIVATE key  — MUST NOT be mounted; in production boot fails if it is
 *
 * It uses the RLS-bound `naaradh_app` role only. The tenant comes from the called number via
 * the SECURITY DEFINER resolve_inbound_number(), never from the service role.
 */
export const voiceEnvSchema = z
  .object({
    ...baseEnv,
    ...databaseEnv,
    ...redisEnv,
    ...engineEnv,
    ...phoneHashEnv,
    ...phoneEncryptEnv,
    ...staffDecryptEnv,
    PHONE_ENC_PRIVATE_KEY: z.string().optional(),
    PORT: z.coerce.number().int().positive().default(3003),
    HOST: z.string().default('0.0.0.0'),
    /** Public base URL of this service — tool URLs handed to the engine point here. */
    VOICE_BASE_URL: z.string().url().default('http://localhost:3003'),
    /** Public base URL of hooks — where the engine sends call events. */
    HOOKS_BASE_URL: z.string().url().default('http://localhost:3002'),
    /** Binds tool and webhook URLs to a tenant (shared/signing.ts). */
    ENGINE_WEBHOOK_KEY: z.string().min(32),
    ENGINE_MAX_CONCURRENCY: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(1200),
  })
  .superRefine((env, ctx) => {
    refineEngineEnv(env, ctx);
    // Production: a mounted customer private key is a deployment error — refuse to boot.
    // Locally one .env.local serves every service; voice simply never reads the key.
    if (
      env.NODE_ENV === 'production' &&
      env.PHONE_ENC_PRIVATE_KEY !== undefined &&
      env.PHONE_ENC_PRIVATE_KEY.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PHONE_ENC_PRIVATE_KEY'],
        message: 'must NOT be mounted into apps/voice (invariant 19, AGENTS §4)',
      });
    }
  });

export type VoiceEnv = z.infer<typeof voiceEnvSchema>;

export function loadVoiceEnv(source: NodeJS.ProcessEnv = process.env): VoiceEnv {
  return loadEnv(voiceEnvSchema, source);
}
