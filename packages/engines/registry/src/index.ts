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

export const engineEnv = {
  ENGINE_DEFAULT_IN: z.enum(KNOWN_VENDORS).default('simulator'),
  ENGINE_DEFAULT_US: z.enum(KNOWN_VENDORS).default('simulator'),
  ENGINE_SECONDARY_IN: z.enum(KNOWN_VENDORS).optional(),
  ENGINE_SECONDARY_US: z.enum(KNOWN_VENDORS).optional(),
  SIMULATOR_WEBHOOK_SECRET: z.string().min(16).default('local_dev_only_simulator_secret'),
  BOLNA_API_KEY: z.string().optional(),
  OMNIDIM_API_KEY: z.string().optional(),
  RETELL_API_KEY: z.string().optional(),
};

export type EngineEnv = z.infer<z.ZodObject<typeof engineEnv>>;

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
