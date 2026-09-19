/**
 * The voice engine contract (SPEC section 5.5).
 *
 * Naaradh rents STT, LLM, TTS, media transport and PSTN termination. This file is the seam
 * that makes them replaceable: product code imports these types and never a vendor SDK
 * (invariant 13, enforced by no-restricted-imports in eslint.config.js).
 *
 * Capability branching is by `capabilities()`, never by vendor name — `if (caps.cancel)`,
 * never `if (vendor === 'bolna')`. A vendor name in an `if` is how the abstraction rots.
 */

import { NaaradhError } from '@naaradh/shared';

export type Locale = 'hi-IN' | 'en-IN' | 'en-US' | 'en-GB' | 'de-DE' | 'fr-FR' | 'es-ES';

export type AnsweredBy = 'human' | 'machine' | 'unknown';

/** What to do when answering-machine detection fires (E-24). */
export type AmdMode = 'hangup' | 'leave_message' | 'continue';

export interface EngineAgentRef {
  readonly vendor: string;
  readonly agentId: string;
}

export interface EngineCallRef {
  readonly vendor: string;
  readonly callId: string;
}

export interface PhoneNumber {
  readonly e164: string;
  readonly region: string;
  readonly provider: string;
  readonly capabilities: { readonly outbound: boolean; readonly inbound: boolean };
}

export interface AgentSpec {
  readonly name: string;
  readonly locale: Locale;
  /** Rendered from an approved, immutable script version in packages/scripts. */
  readonly systemPrompt: string;
  /**
   * The opening line as a TEMPLATE: `{{slot}}` placeholders stay in, and the engine fills them
   * per call from `PlaceCallRequest.variables`. An agent is created once per script version and
   * reused for every call on it, so a greeting with one customer's values baked in would be
   * spoken to the next customer too.
   */
  readonly firstUtterance: string;
  readonly voiceId: string;
  readonly maxDurationSec: number;
  /** Mid-call tools (ADR-0006) — the same definitions inbound calls get, with tenant-bound URLs. */
  readonly tools?: readonly ToolDefinition[];
  /**
   * The tenant-tagged events URL. Engines that bind webhooks to an agent rather than to each
   * call (Retell) set it here; per-call engines use `PlaceCallRequest.webhookUrl` and ignore
   * it. Agents are per tenant (scripts are tenant-owned), so one URL per agent is exact.
   */
  readonly webhookUrl?: string;
  /**
   * The structured result the call must end with (packages/scripts extraction schemas), as flat
   * JSON Schema. Engines that collect it themselves (Retell's post-call analysis) build their
   * fields from it; the result is validated against the schema again on our side regardless.
   */
  readonly extraction?: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
}

export interface PlaceCallRequest {
  /** E.164. */
  readonly to: string;
  /** CLI. Must be in the allowed pool for the recipient region and purpose (gate step 11). */
  readonly from: string;
  readonly agentRef: EngineAgentRef;
  /**
   * Sanitised, allow-listed variables (E-72). These are DATA: they are rendered into
   * user-visible slots, never concatenated into the system prompt.
   */
  readonly variables: Readonly<Record<string, string | number>>;
  readonly maxDurationSec: number;
  readonly metadata: {
    readonly tenant_id: string;
    readonly campaign_id: string | null;
    readonly call_id: string;
    readonly purpose: string;
    readonly script_version: string;
  };
  /** https://hooks.naaradh.com/engine/<vendor>/<tenant_hmac> */
  readonly webhookUrl: string;
  readonly amd: AmdMode;
  readonly locale: Locale;
  /**
   * Passed to the vendor as its own idempotency key. Replaying the same key must never
   * produce a second call (invariant 10).
   */
  readonly idempotencyKey: string;
}

export interface Turn {
  readonly role: 'agent' | 'customer';
  readonly text: string;
  readonly startMs: number;
}

/**
 * Normalised events. `sequence` is the vendor's ordering where it provides one, else the
 * adapter's own monotonic counter — the results-consumer uses it to detect out-of-order
 * delivery. `eventId` is what `webhook_events.external_event_id` dedupes on (E-22).
 */
interface EventBase {
  readonly eventId: string;
  readonly ref: EngineCallRef;
  readonly at: Date;
  readonly sequence: number | null;
  /**
   * Our `metadata.call_id` (the call_attempts id) echoed back by the vendor, when it does.
   * The results-consumer resolves the attempt by this FIRST — a fast vendor's first webhook
   * can arrive before the dispatcher has committed the engine call id.
   */
  readonly attemptId: string | null;
}

export type EngineEvent =
  | (EventBase & { readonly type: 'call.ringing' })
  | (EventBase & { readonly type: 'call.answered'; readonly answeredBy: AnsweredBy })
  | (EventBase & {
      readonly type: 'call.disclosed';
      /** Set when the disclosure segment finished playing (invariant 7). */
      readonly aiDisclosedAt: Date;
      readonly recordingDisclosedAt: Date;
    })
  | (EventBase & {
      readonly type: 'call.transferred';
      readonly toMasked: string;
      readonly result: 'completed' | 'no_answer' | 'busy' | 'failed';
    })
  | (EventBase & {
      readonly type: 'call.ended';
      readonly reason: EndReason;
      readonly answeredBy: AnsweredBy;
      readonly durationSec: number;
      /** From the vendor CDR where available — margin reporting depends on it (E-33). */
      readonly billableSec: number | null;
      readonly humanSpeechSec: number | null;
      readonly recordingUrl: string | null;
      readonly transcript: readonly Turn[] | null;
      readonly extracted: Readonly<Record<string, unknown>> | null;
      readonly detectedLocale: string | null;
      readonly vendorCost: { readonly minor: number; readonly currency: string } | null;
    })
  | (EventBase & {
      readonly type: 'call.failed';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    });

/**
 * The customer refused the recording (P6-CMP-1) — said by the end reason, or only by the
 * extraction when an engine cannot end the call with a reason of its own.
 */
export function recordingRefused(ev: {
  readonly reason: EndReason;
  readonly extracted: Readonly<Record<string, unknown>> | null;
}): boolean {
  return ev.reason === 'recording_refused' || ev.extracted?.['outcome'] === 'recording_refused';
}

/** A refused call keeps neither the audio link nor the words, from the first byte we store. */
export function withoutRefusedMedia<E extends EngineEvent>(ev: E): E {
  if (ev.type !== 'call.ended' || !recordingRefused(ev)) return ev;
  return { ...ev, recordingUrl: null, transcript: null };
}

export type EndReason =
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'amd_hangup'
  | 'amd_message_left'
  | 'customer_hangup'
  | 'max_duration'
  | 'opt_out'
  | 'wrong_number'
  | 'minor_answered'
  | 'recording_refused'
  | 'transfer_completed'
  | 'transfer_failed'
  | 'cancelled'
  | 'invalid_number'
  | 'carrier_temp_fail'
  | 'engine_error';

export interface EngineCallSnapshot {
  readonly ref: EngineCallRef;
  readonly status: 'queued' | 'ringing' | 'in_progress' | 'ended' | 'failed' | 'not_found';
  readonly answeredBy: AnsweredBy | null;
  readonly durationSec: number | null;
  readonly billableSec: number | null;
  readonly endReason: EndReason | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

export interface HealthStatus {
  readonly healthy: boolean;
  readonly detail?: string;
}

/**
 * What a vendor can actually do. Product code branches on these, never on vendor identity.
 * `perSecondBilling` must be confirmed from an invoice or CDR, never from documentation
 * (Q-04) — it is the difference between 50% and 78% gross margin.
 */
export interface EngineCapabilities {
  readonly inbound: boolean;
  readonly cancel: boolean;
  readonly warmTransfer: boolean;
  readonly midCallTools: boolean;
  readonly perSecondBilling: boolean;
  readonly recordingToggle: boolean;
  /** Whether the vendor signs its webhooks. If false, every event must be re-fetched (E-23). */
  readonly signedWebhooks: boolean;
  /** Whether call.ended carries the disclosure timestamps, or the adapter must infer them. */
  readonly reportsDisclosure: boolean;
}

export interface VoiceEngineAdapter {
  readonly vendor: string;

  capabilities(): EngineCapabilities;

  createAgent(spec: AgentSpec): Promise<EngineAgentRef>;
  updateAgent(ref: EngineAgentRef, spec: AgentSpec): Promise<void>;

  /**
   * MUST throw `EngineRateLimited` on 429 (with the vendor's Retry-After), `EngineUnavailable`
   * on 5xx/network failure, and `EngineDispatchUncertain` when the request may have been
   * accepted but no confirmation arrived (timeout after send). The dispatcher treats those
   * three differently (AGENTS §5.3); anything else is a bug.
   */
  placeCall(req: PlaceCallRequest): Promise<EngineCallRef>;

  /** Only present when `capabilities().cancel` is true (E-40). */
  cancelCall?(ref: EngineCallRef): Promise<void>;

  /** Point a number we own at our inbound-context endpoint (provisioning, not per call). */
  attachInboundNumber?(e164: string, inboundUrl: string): Promise<void>;

  // --- Inbound + mid-call tools (ADR-0006). The adapter TRANSLATES; apps/voice DECIDES. ---

  /**
   * A call arrived on one of our numbers and the vendor asks who should answer. MUST verify
   * the vendor's signature and throw SignatureInvalidError otherwise (invariant 9).
   */
  parseInboundRequest(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): InboundCallRequest;

  /** Our decision (answer / forward / closed message) in the vendor's response format. */
  formatInboundResponse(decision: InboundDecision): EngineHttpResponse;

  /** The agent invoked one of our tools mid-call. MUST verify the signature. */
  parseToolCall(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): ToolCallRequest;

  /** A tool result (and any call action it carries, e.g. transfer) in the vendor's format. */
  formatToolResult(result: ToolResult): EngineHttpResponse;

  /**
   * Normalises a vendor webhook. MUST verify the signature and throw SignatureInvalidError
   * when it does not match; for unsigned vendors (`signedWebhooks: false`) the caller
   * re-fetches with `fetchCall` before writing any outcome or billing row (E-23).
   */
  parseWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: Buffer): EngineEvent;

  /** Source of truth after an uncertain dispatch or a missing webhook (E-21). */
  fetchCall(ref: EngineCallRef): Promise<EngineCallSnapshot>;

  /** Look a call up by the idempotency key we sent — the UNCERTAIN path (AGENTS §5.3). */
  findCallByIdempotencyKey(key: string): Promise<EngineCallSnapshot | null>;

  listNumbers(): Promise<readonly PhoneNumber[]>;

  healthcheck(): Promise<HealthStatus>;
}

// ---------------------------------------------------------------------------
// Inbound + tool types (ADR-0006)
// ---------------------------------------------------------------------------

export interface InboundCallRequest {
  readonly vendor: string;
  readonly vendorCallId: string;
  /** OUR number that was dialled — the only source of the tenant (invariant 16). */
  readonly calledE164: string;
  /** Null when the caller withheld their number (E-80). */
  readonly callerE164: string | null;
  readonly at: Date;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, generated from the Zod schema in packages/scripts. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly url: string;
  readonly timeoutMs: number;
  /** Spoken by the engine while the tool runs (E-93). */
  readonly fillerUtterance: string | null;
}

export type InboundDecision =
  | {
      readonly kind: 'answer';
      readonly attemptId: string;
      readonly firstUtterance: string;
      readonly systemPrompt: string;
      readonly variables: Readonly<Record<string, string>>;
      readonly tools: readonly ToolDefinition[];
      readonly maxDurationSec: number;
      readonly locale: Locale;
      readonly voiceId: string | null;
      /** Where the engine sends this call's events (hooks, tenant-tagged) — same as outbound. */
      readonly webhookUrl: string;
    }
  /** E-92: the agent cannot take the call; hand it to the merchant's own number. */
  | { readonly kind: 'forward'; readonly toE164: string; readonly announcement: string | null }
  /** E-81/E-92: no forward available; speak this and hang up. Never silence. */
  | { readonly kind: 'closed'; readonly message: string; readonly locale: Locale };

export interface ToolCallRequest {
  readonly vendor: string;
  readonly vendorCallId: string;
  /** The vendor's id for this invocation — retried invocations share it. */
  readonly toolCallId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Our attempt id echoed from call metadata, when the vendor supports it. */
  readonly attemptId: string | null;
}

export type ToolCallAction =
  | { readonly kind: 'transfer'; readonly toE164: string; readonly warmSummary: string | null }
  | { readonly kind: 'end_call'; readonly reason: string };

export interface ToolResult {
  readonly ok: boolean;
  /** Facts the agent may speak from. Nothing else about the caller or their orders exists for it. */
  readonly data: Readonly<Record<string, unknown>>;
  /** A suggested sentence when there is one obvious thing to say. */
  readonly say: string | null;
  /** Something the engine must do on the call (transfer, hang up). */
  readonly action: ToolCallAction | null;
}

export interface EngineHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// The three errors the dispatcher handles differently. Adapters map vendor responses to
// exactly these; the dispatcher never sees a vendor status code.
// ---------------------------------------------------------------------------

export class EngineRateLimited extends NaaradhError {
  constructor(vendor: string, retryAfterSec: number) {
    super('RATE_LIMITED', `${vendor} rate limited`, {
      context: { vendor },
      retryable: true,
      retryAfterSec,
    });
  }
}

export class EngineUnavailable extends NaaradhError {
  constructor(vendor: string, detail: string, cause?: unknown) {
    super('ENGINE_UNAVAILABLE', `${vendor} unavailable: ${detail}`, {
      context: { vendor, detail },
      retryable: true,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** The request was sent; whether a call exists is unknown. Never retry blindly (AGENTS §5.3). */
export class EngineDispatchUncertain extends NaaradhError {
  constructor(vendor: string, idempotencyKey: string, cause?: unknown) {
    super('DISPATCH_UNCERTAIN', `${vendor} did not confirm dispatch`, {
      context: { vendor, idempotency_key: idempotencyKey },
      retryable: false,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
