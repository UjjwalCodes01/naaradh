import { z } from 'zod';
import { NaaradhError } from '@naaradh/shared';
import type { VoiceEngineAdapter } from '@naaradh/engines-core';
import { SimulatorAdapter, type SimulatorOptions } from '@naaradh/engine-simulator';

/**
 * Vendor registry. Adding an engine means: a package under packages/engines/<vendor>, its
 * env schema here, and a case in `createAdapter`. Nothing else in the repo changes — that is
 * the whole point of invariant 13.
 *
 * India primary/secondary are undecided until ADR-0001; only the simulator exists today.
 */

export const KNOWN_VENDORS = ['simulator', 'bolna', 'omnidim', 'retell'] as const;
export type Vendor = (typeof KNOWN_VENDORS)[number];

export const SIMULATOR_DEV_SECRET = 'local_dev_only_simulator_secret';

export const engineEnv = {
  ENGINE_DEFAULT_IN: z.enum(KNOWN_VENDORS).default('simulator'),
  ENGINE_DEFAULT_US: z.enum(KNOWN_VENDORS).default('simulator'),
  ENGINE_SECONDARY_IN: z.enum(KNOWN_VENDORS).optional(),
  ENGINE_SECONDARY_US: z.enum(KNOWN_VENDORS).optional(),
  SIMULATOR_WEBHOOK_SECRET: z.string().min(16).default(SIMULATOR_DEV_SECRET),
  /**
   * The simulator never dials a real number, but a production service configured with it
   * silently places no calls at all. Staging sets this to run load tests on the simulator;
   * production must not (refineEngineEnv).
   */
  SIMULATOR_ALLOWED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BOLNA_API_KEY: z.string().optional(),
  OMNIDIM_API_KEY: z.string().optional(),
  RETELL_API_KEY: z.string().optional(),
};

/** SIMULATOR_ALLOWED is optional for callers that build the env by hand (tests, registries). */
export type EngineEnv = Omit<z.infer<z.ZodObject<typeof engineEnv>>, 'SIMULATOR_ALLOWED'> & {
  readonly SIMULATOR_ALLOWED?: boolean;
};

/**
 * Cross-field rules every service that spreads `engineEnv` must apply in its `superRefine`
 * (hooks, voice, workers): in production the simulator is refused unless SIMULATOR_ALLOWED is
 * set explicitly, and the shared dev webhook secret is never accepted — with it, anyone could
 * forge "signed" call events for a simulator-backed tenant.
 */
export function refineEngineEnv(env: EngineEnv & { NODE_ENV: string }, ctx: z.RefinementCtx): void {
  if (env.NODE_ENV !== 'production') return;
  const usesSimulator = (
    [
      env.ENGINE_DEFAULT_IN,
      env.ENGINE_DEFAULT_US,
      env.ENGINE_SECONDARY_IN,
      env.ENGINE_SECONDARY_US,
    ] as const
  ).some((v) => v === 'simulator');
  if (usesSimulator && env.SIMULATOR_ALLOWED !== true)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ENGINE_DEFAULT_IN'],
      message:
        'the simulator engine is configured in production; set the ADR-0001 engine, or SIMULATOR_ALLOWED=true on a staging-like environment',
    });
  if (usesSimulator && env.SIMULATOR_WEBHOOK_SECRET === SIMULATOR_DEV_SECRET)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SIMULATOR_WEBHOOK_SECRET'],
      message: 'the shared development secret is not allowed in production',
    });
}

export interface RegistryOptions {
  readonly env: EngineEnv;
  /** Simulator-only: where emitted webhooks go (tests inject a sink; dev posts to hooks). */
  readonly simulator?: Partial<SimulatorOptions>;
}

export function isVendor(value: string): value is Vendor {
  return (KNOWN_VENDORS as readonly string[]).includes(value);
}

export class EngineRegistry {
  private readonly cache = new Map<Vendor, VoiceEngineAdapter>();

  constructor(private readonly options: RegistryOptions) {}

  get(vendor: string): VoiceEngineAdapter {
    if (!isVendor(vendor))
      throw new NaaradhError('INTERNAL', `unknown engine vendor`, { context: { vendor } });
    const cached = this.cache.get(vendor);
    if (cached !== undefined) return cached;
    const adapter = this.create(vendor);
    this.cache.set(vendor, adapter);
    return adapter;
  }

  private create(vendor: Vendor): VoiceEngineAdapter {
    switch (vendor) {
      case 'simulator':
        return new SimulatorAdapter({
          webhookSecret: this.options.env.SIMULATOR_WEBHOOK_SECRET,
          ...this.options.simulator,
        });
      case 'bolna':
      case 'omnidim':
      case 'retell':
        throw new NaaradhError(
          'ENGINE_UNAVAILABLE',
          `${vendor} adapter is not implemented — blocked on ADR-0001 (bake-off)`,
          {
            context: { vendor },
          },
        );
    }
  }
}
