import {
  EngineDispatchUncertain,
  EngineRateLimited,
  EngineUnavailable,
  type AgentSpec,
  type EngineAgentRef,
  type EngineCallRef,
  type EngineCallSnapshot,
  type EngineCapabilities,
  type EngineEvent,
  type EngineHttpResponse,
  type HealthStatus,
  type InboundCallRequest,
  type InboundDecision,
  type PhoneNumber,
  type PlaceCallRequest,
  type ToolCallRequest,
  type ToolResult,
  type VoiceEngineAdapter,
} from '@naaradh/engines-core';
import { NaaradhError } from '@naaradh/shared';
import { mapWebhook, requestIdOf, snapshotOf } from './map-events.js';
import type { OmniCallLog, OmniWebhook } from './wire.js';

export { mapWebhook, snapshotOf, extractedOf, requestIdOf } from './map-events.js';
export type { OmniCallLog, OmniWebhook } from './wire.js';

/**
 * OmniDimension (direct API, not OmniRelay) — the India secondary candidate (ADR-0001;
 * P1-ENG-3). HTTP over `fetch`, no vendor SDK. **Outbound calls without tools only**: enough
 * for COD confirmation, cart recovery, feedback and reminders; not for the support line.
 *
 * What it does not do, declared in `capabilities()` so product code never assumes it:
 *   midCallTools    a "Custom API" tool can only be created in OmniDimension's dashboard, by
 *                   hand; ours are per tenant and per call. No tools → no inbound either.
 *   inbound         needs tools and a per-call decision; neither exists over the API.
 *   warmTransfer    targets are fixed on the agent (invariant 19 needs per-call targets).
 *   cancel          no endpoint stops a single dispatched call.
 *   progressEvents  one post-call webhook, nothing while the call is live.
 *   callLookup      the call log does not echo our metadata, so a call cannot be found by our
 *                   key — only its post-call webhook names our attempt. The reconciler waits
 *                   that webhook out before re-dialling (invariant 10).
 *   signedWebhooks  nothing is signed; the outcome is written from the fetched call log (E-23).
 *
 * Every wire detail is from the published API reference and marked [VERIFY] (go-live 03).
 */

export interface OmnidimOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Voice per locale for AgentSpec.voiceId 'default': { provider, voice_id }. [VERIFY] ids. */
  readonly voices?: Readonly<Record<string, { provider: string; voice_id: string }>>;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_VOICE = { provider: 'eleven_labs', voice_id: 'JBFqnCBsd6RMkjVDRZzb' };

/** Every outcome must reach us, not only the two OmniDimension sends by default. */
const ALL_STATUSES = [
  'completed',
  'voicemail_detected',
  'failed',
  'no_answer',
  'busy',
  'cancelled',
];

class OmnidimHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSec: number,
  ) {
    super(`omnidim HTTP ${String(status)}`);
  }
}

export class OmnidimAdapter implements VoiceEngineAdapter {
  readonly vendor = 'omnidim';
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;
  private numberIds: { at: number; byE164: Map<string, number> } | null = null;

  constructor(private readonly options: OmnidimOptions) {
    this.base = options.baseUrl ?? 'https://omnidim.io/api/v1';
    this.doFetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  capabilities(): EngineCapabilities {
    return {
      inbound: false,
      cancel: false,
      warmTransfer: false,
      midCallTools: false,
      // Q-04: never from documentation — flip only after an invoice shows per-second billing.
      perSecondBilling: false,
      recordingToggle: false,
      signedWebhooks: false,
      reportsDisclosure: false,
      progressEvents: false,
      callLookup: false,
    };
  }

  // --- HTTP ------------------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (res.status === 429 || res.status >= 500) {
      const retry = Number(res.headers.get('retry-after') ?? '');
      // "Back off and retry after a minute" (OmniDimension's error guide).
      throw new OmnidimHttpError(res.status, Number.isFinite(retry) && retry > 0 ? retry : 60);
    }
    if (res.status === 404) throw new OmnidimHttpError(404, 0);
    if (!res.ok) {
      throw new NaaradhError('INTERNAL', `omnidim rejected ${method} ${path.split('/')[1] ?? ''}`, {
        context: { vendor: this.vendor, status: res.status },
        retryable: false,
      });
    }
    return (await res.json()) as T;
  }

  /** Maps transport failures to the three errors the dispatcher distinguishes (AGENTS §5.3). */
  private mapError(error: unknown, idempotencyKey: string | null): never {
    if (error instanceof NaaradhError) throw error;
    if (error instanceof OmnidimHttpError) {
      if (error.status === 429) throw new EngineRateLimited(this.vendor, error.retryAfterSec);
      throw new EngineUnavailable(this.vendor, `HTTP ${String(error.status)}`, error);
    }
    const name = error instanceof Error ? error.name : '';
    if (idempotencyKey !== null && (name === 'TimeoutError' || name === 'AbortError'))
      throw new EngineDispatchUncertain(this.vendor, idempotencyKey, error);
    throw new EngineUnavailable(this.vendor, name === '' ? 'network error' : name, error);
  }

  // --- agents ----------------------------------------------------------------------------------

  private agentBody(spec: AgentSpec): Record<string, unknown> {
    const voice =
      spec.voiceId !== 'default'
        ? { ...DEFAULT_VOICE, voice_id: spec.voiceId }
        : ((this.options.voices ?? {})[spec.locale] ?? DEFAULT_VOICE);
    return {
      name: spec.name.slice(0, 120),
      // `{{slot}}` placeholders are filled per call from call_context; spoken word for word.
      welcome_message: spec.firstUtterance,
      is_welcome_message_dynamic: false,
      // The disclosure is the first utterance of every call (invariant 7): never cut short.
      is_welcome_message_interruption: false,
      context_breakdown: [{ title: 'Instructions', body: spec.systemPrompt, is_enabled: true }],
      call_type: 'Outgoing',
      transcriber: {
        provider: 'deepgram_stream',
        model: 'nova-3',
        language: spec.locale === 'hi-IN' ? 'hi' : spec.locale,
        max_call_duration_in_sec: spec.maxDurationSec,
      },
      model: { model: this.options.model ?? 'gpt-4.1-mini', temperature: 0.2 },
      voice,
      end_call: {
        enabled: true,
        condition:
          'The conversation is over, or the instructions say to end the call (opt-out, wrong number, a child, recording refused).',
        message_type: 'static',
        message: '',
      },
      ...(spec.webhookUrl === undefined
        ? {}
        : {
            post_call_actions: {
              webhook: {
                enabled: true,
                url: spec.webhookUrl,
                include: ['extracted_variables', 'fullConversation'],
                extracted_variables:
                  spec.extraction === undefined ? [] : extractionVariables(spec.extraction.schema),
                trigger_call_statuses: ALL_STATUSES,
              },
            },
          }),
    };
  }

  async createAgent(spec: AgentSpec): Promise<EngineAgentRef> {
    try {
      const agent = await this.request<{ id: number }>(
        'POST',
        '/agents/create',
        this.agentBody(spec),
      );
      return { vendor: this.vendor, agentId: String(agent.id) };
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  async updateAgent(ref: EngineAgentRef, spec: AgentSpec): Promise<void> {
    try {
      await this.request('PUT', `/agents/${encodeURIComponent(ref.agentId)}`, this.agentBody(spec));
    } catch (error) {
      this.mapError(error, null);
    }
  }

  // --- calls -----------------------------------------------------------------------------------

  private async listAllNumbers(): Promise<{ id: number; phone_number: string }[]> {
    const page = await this.request<{ phone_numbers?: { id: number; phone_number: string }[] }>(
      'GET',
      '/phone_number/list?pageno=1&pagesize=150',
    );
    return page.phone_numbers ?? [];
  }

  /** OmniDimension dials from a number ID, not an E.164; the list changes rarely. */
  private async numberId(e164: string): Promise<number> {
    const fresh = this.numberIds !== null && this.now().getTime() - this.numberIds.at < 300_000;
    if (!fresh || this.numberIds?.byE164.get(e164) === undefined)
      this.numberIds = {
        at: this.now().getTime(),
        byE164: new Map((await this.listAllNumbers()).map((n) => [n.phone_number, n.id])),
      };
    const id = this.numberIds.byE164.get(e164);
    // Never fall back to the platform's default number: the CLI was chosen by the gate for
    // this recipient and purpose (gate step 11), and an unknown CLI into India is a violation.
    if (id === undefined)
      throw new NaaradhError('INTERNAL', 'the caller ID is not on the omnidim account', {
        context: { vendor: this.vendor },
        retryable: false,
      });
    return id;
  }

  async placeCall(req: PlaceCallRequest): Promise<EngineCallRef> {
    const agentId = Number(req.agentRef.agentId);
    try {
      const fromId = await this.numberId(req.from);
      const res = await this.request<{
        success?: boolean;
        requestId?: number;
        error?: string;
        plan_expire?: boolean;
      }>('POST', '/calls/dispatch', {
        agent_id: agentId,
        to_number: req.to,
        from_number_id: fromId,
        // DATA for the `{{slot}}`s (E-72).
        call_context: Object.fromEntries(
          Object.entries(req.variables).map(([k, v]) => [k, String(v)]),
        ),
        // Not shown to the agent; echoed on the post-call webhook — the only thing that ties
        // OmniDimension's call back to our attempt.
        metadata: {
          naaradh_attempt_id: req.metadata.call_id,
          naaradh_idempotency_key: req.idempotencyKey,
        },
      });
      if (res.success === false || typeof res.requestId !== 'number') {
        // A business refusal arrives as HTTP 200: the plan's concurrency limit, or no balance.
        if (res.plan_expire === true)
          throw new EngineUnavailable(this.vendor, 'plan or balance exhausted');
        if (/concurren|limit/i.test(res.error ?? '')) throw new EngineRateLimited(this.vendor, 30);
        throw new NaaradhError('INTERNAL', 'omnidim refused the dispatch', {
          context: { vendor: this.vendor },
          retryable: false,
        });
      }
      return { vendor: this.vendor, callId: String(res.requestId) };
    } catch (error) {
      return this.mapError(error, req.idempotencyKey);
    }
  }

  parseWebhook(
    _headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): EngineEvent | null {
    // Nothing to verify: OmniDimension does not sign. The URL's tenant tag was checked by the
    // route, and nothing here is believed until fetchCall() confirms it.
    const body = JSON.parse(rawBody.toString('utf8')) as OmniWebhook;
    return mapWebhook(body, this.vendor, this.now());
  }

  /** The call log for a dispatch request id: newest logs first, a few pages at most. */
  async fetchCall(ref: EngineCallRef): Promise<EngineCallSnapshot> {
    try {
      for (let page = 1; page <= 4; page += 1) {
        const res = await this.request<{ call_log_data?: OmniCallLog[] }>(
          'GET',
          `/calls/logs?pageno=${String(page)}&pagesize=150`,
        );
        const rows = res.call_log_data ?? [];
        const hit = rows.find((r) => requestIdOf(r.call_request_id) === ref.callId);
        if (hit !== undefined) {
          // The list row may be trimmed; the single log has the transcript and variables.
          const full = await this.request<{ call_log_data?: OmniCallLog[] }>(
            'GET',
            `/calls/logs/${String(hit.id)}`,
          );
          return snapshotOf(full.call_log_data?.[0] ?? hit, this.vendor, ref.callId);
        }
        if (rows.length < 150) break;
      }
      return snapshotOf(null, this.vendor, ref.callId);
    } catch (error) {
      if (error instanceof OmnidimHttpError && error.status === 404)
        return snapshotOf(null, this.vendor, ref.callId);
      return this.mapError(error, null);
    }
  }

  /** Not possible on OmniDimension (`callLookup: false`): the log does not carry our key. */
  findCallByIdempotencyKey(_key: string): Promise<EngineCallSnapshot | null> {
    return Promise.resolve(null);
  }

  async listNumbers(): Promise<readonly PhoneNumber[]> {
    try {
      return (await this.listAllNumbers()).map((n) => ({
        e164: n.phone_number,
        region: n.phone_number.startsWith('+91') ? 'IN' : 'ZZ',
        provider: 'omnidim',
        capabilities: { outbound: true, inbound: false },
      }));
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  async healthcheck(): Promise<HealthStatus> {
    try {
      await this.listAllNumbers();
      return { healthy: true };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : 'unknown' };
    }
  }

  // --- inbound + tools: not supported (see the class comment) -------------------------------------

  parseInboundRequest(): InboundCallRequest {
    throw new EngineUnavailable(this.vendor, 'inbound is not supported on omnidim');
  }

  formatInboundResponse(_decision: InboundDecision): EngineHttpResponse {
    throw new EngineUnavailable(this.vendor, 'inbound is not supported on omnidim');
  }

  parseToolCall(): ToolCallRequest {
    throw new EngineUnavailable(this.vendor, 'mid-call tools are not supported on omnidim');
  }

  formatToolResult(_result: ToolResult): EngineHttpResponse {
    throw new EngineUnavailable(this.vendor, 'mid-call tools are not supported on omnidim');
  }
}

/**
 * Our flat extraction schema → OmniDimension's extracted variables. Answers come back as text,
 * so typed fields are named `field__i|f|b` and restored by extractedOf.
 */
export function extractionVariables(
  schema: Readonly<Record<string, unknown>>,
): { key: string; prompt: string }[] {
  const properties = (schema['properties'] ?? {}) as Record<
    string,
    { type?: string; enum?: string[] }
  >;
  return Object.entries(properties).map(([name, p]) => {
    const label = name.replace(/_/g, ' ');
    if (p.enum !== undefined)
      return {
        key: name,
        prompt: `The call's ${label}. Answer with exactly one of: ${p.enum.join(', ')}.`,
      };
    if (p.type === 'boolean')
      return { key: `${name}__b`, prompt: `${label}? Answer true or false.` };
    if (p.type === 'integer' || p.type === 'number')
      return {
        key: `${name}__${p.type === 'integer' ? 'i' : 'f'}`,
        prompt:
          name === 'confidence'
            ? 'How sure you are of the outcome, as a number from 0 to 1. Digits only.'
            : `The call's ${label}, as a number. Digits only.`,
      };
    return { key: name, prompt: `The call's ${label}, if there was one.` };
  });
}
