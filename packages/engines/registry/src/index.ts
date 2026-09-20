import { z } from 'zod';
import { NaaradhError } from '@naaradh/shared';
import type { VoiceEngineAdapter } from '@naaradh/engines-core';
import { BolnaAdapter, type BolnaVoice } from '@naaradh/engine-bolna';
import { OmnidimAdapter } from '@naaradh/engine-omnidim';
import { RetellAdapter } from '@naaradh/engine-retell';
import { SimulatorAdapter, type SimulatorOptions } from '@naaradh/engine-simulator';

/**
 * Vendor registry. Adding an engine means: a package under packages/engines/<vendor>, its
 * env schema here, and a case in `createAdapter`. Nothing else in the repo changes — that is
 * the whole point of invariant 13.
 *
 * All three vendor adapters exist, each written from the vendor's published API and not yet
 * run against a real account ([VERIFY] throughout; go-live 03 and 10). WHICH Indian engine is
 * primary is still ADR-0001's decision — the bake-off now runs through these adapters:
 * `ENGINE_DEFAULT_IN=bolna|omnidim`. Retell serves US/UK/EU (`ENGINE_DEFAULT_US=retell`).
 */

/** `{"hi-IN": …}` style JSON env values. */
const jsonObject = <T>(name: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      try {
        const parsed = JSON.parse(v) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
          return parsed as Record<string, T>;
      } catch {
        // fall through
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be a JSON object` });
      return z.NEVER;
    });

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
  /** Voice per locale for Retell agents, JSON: {"en-US":"11labs-Adrian"}. [VERIFY] ids. */
  RETELL_VOICES: jsonObject<string>('RETELL_VOICES'),
  RETELL_MODEL: z.string().optional(),
  /**
   * The bearer Bolna presents when its agent calls one of our tools or asks who is calling
   * (Bolna signs nothing). ≥ 32 random characters; unset → Bolna agents get no tools.
   */
  BOLNA_TOOL_TOKEN: z.string().min(32).optional(),
  /** Inbound on Bolna stays off until it has been seen working on a real call (Q-34). */
  BOLNA_INBOUND: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** The telephony account connected to Bolna, which the numbers belong to. */
  BOLNA_TELEPHONY_PROVIDER: z.enum(['plivo', 'exotel', 'twilio', 'vobiz', 'sip-trunk']).optional(),
  /** `provider/model` of the LLM behind Bolna agents, e.g. `openai/gpt-4.1-mini`. */
  BOLNA_LLM: z
    .string()
    .regex(/^[a-z0-9-]+\/.+$/)
    .optional(),
  /** Voice per locale, JSON: {"hi-IN":{"provider":"sarvam","voice":"…","voice_id":"…","model":"bulbul:v3","language":"hi"}}. */
  BOLNA_VOICES: jsonObject<BolnaVoice>('BOLNA_VOICES'),
  /** Voice per locale, JSON: {"hi-IN":{"provider":"sarvam","voice_id":"…"}}. */
  OMNIDIM_VOICES: jsonObject<{ provider: string; voice_id: string }>('OMNIDIM_VOICES'),
  OMNIDIM_MODEL: z.string().optional(),
};

/** SIMULATOR_ALLOWED is optional for callers that build the env by hand (tests, registries). */
export type EngineEnv = Omit<
  z.infer<z.ZodObject<typeof engineEnv>>,
  'SIMULATOR_ALLOWED' | 'BOLNA_INBOUND'
> & {
  readonly SIMULATOR_ALLOWED?: boolean;
  readonly BOLNA_INBOUND?: boolean;
};

/**
 * Cross-field rules every service that spreads `engineEnv` must apply in its `superRefine`
 * (hooks, voice, workers): in production the simulator is refused unless SIMULATOR_ALLOWED is
 * set explicitly, and the shared dev webhook secret is never accepted — with it, anyone could
 * forge "signed" call events for a simulator-backed tenant.
 */
export function refineEngineEnv(env: EngineEnv & { NODE_ENV: string }, ctx: z.RefinementCtx): void {
  const configured = [
    env.ENGINE_DEFAULT_IN,
    env.ENGINE_DEFAULT_US,
    env.ENGINE_SECONDARY_IN,
    env.ENGINE_SECONDARY_US,
  ];
  // Any environment: an engine chosen without its credentials fails at boot, not on a call.
  for (const [vendor, key] of [
    ['retell', 'RETELL_API_KEY'],
    ['bolna', 'BOLNA_API_KEY'],
    ['omnidim', 'OMNIDIM_API_KEY'],
  ] as const)
    if (configured.includes(vendor) && (env[key] ?? '').length < 16)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${vendor} is configured as an engine but ${key} is not set`,
      });
  if (env.BOLNA_INBOUND && env.BOLNA_TOOL_TOKEN === undefined)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BOLNA_TOOL_TOKEN'],
      message: 'BOLNA_INBOUND=true needs BOLNA_TOOL_TOKEN (it authenticates the caller lookup)',
    });
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
      case 'retell':
        return new RetellAdapter({
          apiKey: this.options.env.RETELL_API_KEY ?? '',
          ...(this.options.env.RETELL_VOICES === undefined
            ? {}
            : { voices: this.options.env.RETELL_VOICES }),
          ...(this.options.env.RETELL_MODEL === undefined
            ? {}
            : { model: this.options.env.RETELL_MODEL }),
        });
      case 'bolna': {
        const env = this.options.env;
        const [provider, ...model] = (env.BOLNA_LLM ?? '').split('/');
        return new BolnaAdapter({
          apiKey: env.BOLNA_API_KEY ?? '',
          toolToken: env.BOLNA_TOOL_TOKEN,
          inboundEnabled: env.BOLNA_INBOUND ?? false,
          ...(env.BOLNA_TELEPHONY_PROVIDER === undefined
            ? {}
            : { telephonyProvider: env.BOLNA_TELEPHONY_PROVIDER }),
          ...(env.BOLNA_LLM === undefined || provider === undefined
            ? {}
            : { llm: { provider, model: model.join('/') } }),
          ...(env.BOLNA_VOICES === undefined ? {} : { voices: env.BOLNA_VOICES }),
        });
      }
      case 'omnidim':
        return new OmnidimAdapter({
          apiKey: this.options.env.OMNIDIM_API_KEY ?? '',
          ...(this.options.env.OMNIDIM_VOICES === undefined
            ? {}
            : { voices: this.options.env.OMNIDIM_VOICES }),
          ...(this.options.env.OMNIDIM_MODEL === undefined
            ? {}
            : { model: this.options.env.OMNIDIM_MODEL }),
        });
    }
  }
}
