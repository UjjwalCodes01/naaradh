import type { Redis } from 'ioredis';
import type { Db } from '@naaradh/db';
import type { Clock, Logger } from '@naaradh/shared';
import type { EngineRegistry } from '@naaradh/engines-registry';
import type { CalendarRegistry } from '@naaradh/calendar';
import type { DndProvider, GateDepsConfig } from '@naaradh/compliance';
import type { DataRegion, PhoneKeys } from '@naaradh/pipeline';
import type { RecordingStore } from './results/recordings.js';
import type { ShopifyWriteback } from './results/writeback.js';
import type { RazorpayClient } from '@naaradh/payments';
import type { Mailer } from '@naaradh/notify';
import type { SecretResolver } from './deliveries/secrets.js';

/**
 * Everything a worker needs, built once at startup (index.ts) or by a test. Two database
 * handles on purpose: `app` is RLS-bound and used through withTenant(); `service` bypasses
 * RLS and is used only for the cross-tenant queries each worker is documented to make.
 */
export interface WorkerContext {
  readonly app: Db;
  readonly service: Db;
  readonly redis: Redis;
  readonly registry: EngineRegistry;
  readonly log: Logger;
  readonly clock: Clock;
  readonly keys: PhoneKeys & { readonly privateKeyPem: string | null };
  readonly gate: GateDepsConfig;
  readonly hooksBaseUrl: string;
  /** Public base URL of apps/voice — outbound agents' tool URLs point there (ADR-0006). */
  readonly voiceBaseUrl: string;
  readonly engineWebhookKey: string;
  readonly recordings: RecordingStore;
  readonly shopify: ShopifyWriteback;
  readonly secrets: SecretResolver;
  /** Admin GraphQL settings for every Shopify call a worker makes (write-backs, billing, reconcile). */
  readonly shopifyAdmin: { readonly apiVersion: string; readonly fetchImpl?: typeof fetch };
  /** Null when Razorpay is not configured in this environment. */
  readonly razorpay: RazorpayClient | null;
  /** Merchant email (P2-WEB-4): Postmark in production, in-memory elsewhere. */
  readonly mailer: Mailer;
  /** Links in emails point here (apps/web). */
  readonly dashboardUrl: string;
  readonly workerId: string;
  readonly dispatchBatch: number;
  /**
   * DND/NCPR scrub provider (Q-02). Absent or `none` until a TSP contract exists — and then
   * every promotional call is refused `dnd:unknown` (fail-closed, ADR-0010 §6).
   */
  readonly dnd?: DndProvider;
  /**
   * Appointment calendars (ADR-0011). Absent → reminders still go out, but a cancellation
   * decided on a call is not pushed to the provider.
   */
  readonly calendars?: CalendarRegistry;
  /** The data region this deployment serves (ADR-0012); absent → every tenant. */
  readonly dataRegion?: DataRegion;
}
