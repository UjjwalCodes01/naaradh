import { z } from 'zod';
import { baseEnv, loadEnv, phoneHashEnv, redisEnv, serviceDatabaseEnv } from '@naaradh/shared';

/**
 * The staff console runs behind Identity-Aware Proxy and holds the SERVICE role (it acts across
 * tenants). It never holds a private key: staff see masked numbers like merchants do.
 */
export const consoleEnvSchema = z
  .object({
    ...baseEnv,
    ...serviceDatabaseEnv,
    ...redisEnv,
    ...phoneHashEnv,
    PORT: z.coerce.number().int().positive().default(3004),
    HOST: z.string().default('0.0.0.0'),
    /** `/projects/<number>/global/backendServices/<id>` — the IAP-protected backend (JWT `aud`). */
    IAP_AUDIENCE: z.string().optional(),
    /** Public origin, for the same-origin check on every POST: https://console.naaradh.com */
    CONSOLE_ORIGIN: z.string().url().default('http://localhost:3004'),
    /** Staff allow-list on top of IAP: a domain, a comma list of emails, or both. */
    CONSOLE_ALLOWED_DOMAIN: z.string().default('naaradh.com'),
    CONSOLE_STAFF_EMAILS: z.string().default(''),
    /** Local only: act as this staff email without IAP. Refused in production. */
    CONSOLE_DEV_STAFF_EMAIL: z.string().email().optional(),
    RECORDINGS_BUCKET: z.string().optional(),
    PHONE_ENC_PRIVATE_KEY: z.string().optional(),
    STAFF_ENC_PRIVATE_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const k of ['PHONE_ENC_PRIVATE_KEY', 'STAFF_ENC_PRIVATE_KEY'] as const)
        if (env[k] !== undefined)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: 'must NOT be set for the console (AGENTS §4)',
          });
      if (env.IAP_AUDIENCE === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['IAP_AUDIENCE'],
          message: 'required in production',
        });
      if (env.CONSOLE_DEV_STAFF_EMAIL !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CONSOLE_DEV_STAFF_EMAIL'],
          message: 'must not be set in production',
        });
    }
  });

export type ConsoleEnv = z.infer<typeof consoleEnvSchema>;

export function loadConsoleEnv(source: NodeJS.ProcessEnv = process.env): ConsoleEnv {
  return loadEnv(consoleEnvSchema, source);
}
