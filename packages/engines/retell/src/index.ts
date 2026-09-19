import { createHash } from 'node:crypto';
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
import { NaaradhError, SignatureInvalidError } from '@naaradh/shared';
import { mapWebhook, snapshotOf } from './map-events.js';
import { RETELL_SIGNATURE_HEADER, verifyRetell } from './signature.js';
import type { RetellCall, RetellFunctionCall, RetellWebhook } from './wire.js';

export { signRetell, verifyRetell, RETELL_SIGNATURE_HEADER } from './signature.js';
export { mapWebhook, snapshotOf, connected, answeredBy, endReason } from './map-events.js';
export type { RetellCall, RetellWebhook, RetellFunctionCall } from './wire.js';

/**
 * Retell AI — the US/UK/EU voice engine (P6-ENG-1; CLAUDE.md stack table). HTTP over `fetch`,
 * no vendor SDK (invariant 13 keeps even that inside this package). Retell rents the STT, LLM,
 * TTS and the carrier leg (Twilio/Telnyx numbers imported into the account, P6-ENG-2).
 *
 * What it does NOT do yet, declared in `capabilities()` so product code never assumes it:
 *   inbound       Retell's inbound webhook can pick an agent and set variables, but cannot
 *                 forward the call to the merchant or play a closed message — so it cannot
 *                 honour E-92 (never dead air). US support lines wait for that (Q-31).
 *   warmTransfer  a transfer must go to a number chosen at call time from verified targets
 *                 (invariant 19); Retell transfers only to numbers fixed on the agent.
 *   cancel        there is no documented way to stop a queued outbound call.
 *   AMD per call  voicemail detection is set on the agent; every Retell agent hangs up on a
 *                 machine, whatever the tenant's AMD mode (the safe choice; noted in Q-31).
 *
 * Every wire detail is written from Retell's published API reference and marked [VERIFY]; the
 * go-live checklist (docs/go-live/10-us-eu.md) records real payloads and replaces the fixtures.
 */

export interface RetellOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Voice per locale for AgentSpec.voiceId 'default'. [VERIFY] ids from the Retell dashboard. */
  readonly voices?: Readonly<Record<string, string>>;
  /** LLM behind each agent. [VERIFY] a model the account is enabled for. */
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_VOICES: Readonly<Record<string, string>> = {
  'en-US': '11labs-Adrian',
  'en-GB': '11labs-Anthony',
  'de-DE': '11labs-Adrian',
  'fr-FR': '11labs-Adrian',
  'es-ES': '11labs-Adrian',
};

class RetellHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSec: number,
  ) {
    super(`retell HTTP ${String(status)}`);
  }
}

export class RetellAdapter implements VoiceEngineAdapter {
  readonly vendor = 'retell';
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: RetellOptions) {
    this.base = options.baseUrl ?? 'https://api.retellai.com';
    this.doFetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  capabilities(): EngineCapabilities {
    return {
      inbound: false,
      cancel: false,
      warmTransfer: false,
      midCallTools: true,
      // Q-04: never from documentation — flip only after an invoice shows per-second billing.
      perSecondBilling: false,
      recordingToggle: false,
      signedWebhooks: true,
      reportsDisclosure: false,
    };
  }

  // --- HTTP ------------------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
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
      throw new RetellHttpError(res.status, Number.isFinite(retry) && retry > 0 ? retry : 5);
    }
    if (res.status === 404) throw new RetellHttpError(404, 0);
    if (!res.ok) {
      // Our request was wrong (a caller ID not on the account, a bad agent): not retryable.
      throw new NaaradhError('INTERNAL', `retell rejected ${method} ${path.split('/')[1] ?? ''}`, {
        context: { vendor: this.vendor, status: res.status },
        retryable: false,
      });
    }
    return (await res.json()) as T;
  }

  /** Maps transport failures to the three errors the dispatcher distinguishes (AGENTS §5.3). */
  private mapError(error: unknown, idempotencyKey: string | null): never {
    if (error instanceof NaaradhError) throw error;
    if (error instanceof RetellHttpError) {
      if (error.status === 429) throw new EngineRateLimited(this.vendor, error.retryAfterSec);
      throw new EngineUnavailable(this.vendor, `HTTP ${String(error.status)}`, error);
    }
    const name = error instanceof Error ? error.name : '';
    // A timeout means the request may have arrived: the call may exist. Never re-dial blindly.
    if (idempotencyKey !== null && (name === 'TimeoutError' || name === 'AbortError'))
      throw new EngineDispatchUncertain(this.vendor, idempotencyKey, error);
    throw new EngineUnavailable(this.vendor, name === '' ? 'network error' : name, error);
  }

  // --- agents ----------------------------------------------------------------------------------

  private llmBody(spec: AgentSpec) {
    return {
      general_prompt: spec.systemPrompt,
      // `{{slot}}` placeholders are filled per call from retell_llm_dynamic_variables.
      begin_message: spec.firstUtterance,
      model: this.options.model ?? 'gpt-4o',
      general_tools: [
        {
          type: 'end_call',
          name: 'end_call',
          description:
            'End the call once the conversation is over, or immediately when the rules say to (opt-out, wrong number, a child, recording refused).',
        },
        ...(spec.tools ?? []).map((t) => ({
          type: 'custom',
          name: t.name,
          description: t.description,
          url: t.url,
          parameters: t.parameters,
          timeout_ms: t.timeoutMs,
          speak_during_execution: t.fillerUtterance !== null,
          ...(t.fillerUtterance === null
            ? {}
            : { execution_message_description: t.fillerUtterance }),
          speak_after_execution: true,
        })),
      ],
    };
  }

  private agentBody(spec: AgentSpec, llmId: string) {
    const voice =
      spec.voiceId !== 'default'
        ? spec.voiceId
        : (this.options.voices ?? DEFAULT_VOICES)[spec.locale];
    return {
      agent_name: spec.name.slice(0, 120),
      response_engine: { type: 'retell-llm', llm_id: llmId },
      voice_id: voice ?? DEFAULT_VOICES['en-US'],
      language: spec.locale,
      max_call_duration_ms: spec.maxDurationSec * 1000,
      // Machine detection on every agent: a voicemail is never talked to (E-24).
      enable_voicemail_detection: true,
      ...(spec.webhookUrl === undefined ? {} : { webhook_url: spec.webhookUrl }),
      ...(spec.extraction === undefined
        ? {}
        : { post_call_analysis_data: analysisFields(spec.extraction.schema) }),
    };
  }

  async createAgent(spec: AgentSpec): Promise<EngineAgentRef> {
    try {
      const llm = await this.request<{ llm_id: string }>(
        'POST',
        '/create-retell-llm',
        this.llmBody(spec),
      );
      const agent = await this.request<{ agent_id: string }>(
        'POST',
        '/create-agent',
        this.agentBody(spec, llm.llm_id),
      );
      return { vendor: this.vendor, agentId: agent.agent_id };
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  async updateAgent(ref: EngineAgentRef, spec: AgentSpec): Promise<void> {
    try {
      const agent = await this.request<{ response_engine?: { llm_id?: string } }>(
        'GET',
        `/get-agent/${encodeURIComponent(ref.agentId)}`,
      );
      const llmId = agent.response_engine?.llm_id;
      if (llmId === undefined) throw new NaaradhError('INTERNAL', 'retell agent has no LLM');
      await this.request(
        'PATCH',
        `/update-retell-llm/${encodeURIComponent(llmId)}`,
        this.llmBody(spec),
      );
      await this.request(
        'PATCH',
        `/update-agent/${encodeURIComponent(ref.agentId)}`,
        this.agentBody(spec, llmId),
      );
    } catch (error) {
      this.mapError(error, null);
    }
  }

  // --- calls -----------------------------------------------------------------------------------

  async placeCall(req: PlaceCallRequest): Promise<EngineCallRef> {
    // Retell's dynamic variables are strings; they are DATA for the `{{slot}}`s (E-72).
    const variables = Object.fromEntries(
      Object.entries(req.variables).map(([k, v]) => [k, String(v)]),
    );
    try {
      const call = await this.request<RetellCall>('POST', '/v2/create-phone-call', {
        from_number: req.from,
        to_number: req.to,
        override_agent_id: req.agentRef.agentId,
        // Retell has no idempotency key; ours rides in metadata so the UNCERTAIN path can find
        // the call (findCallByIdempotencyKey). [VERIFY]
        metadata: { ...req.metadata, idempotency_key: req.idempotencyKey },
        retell_llm_dynamic_variables: variables,
      });
      return { vendor: this.vendor, callId: call.call_id };
    } catch (error) {
      return this.mapError(error, req.idempotencyKey);
    }
  }

  parseWebhook(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): EngineEvent {
    this.verify(headers, rawBody);
    const body = JSON.parse(rawBody.toString('utf8')) as RetellWebhook;
    return mapWebhook(body, this.vendor, this.now());
  }

  async fetchCall(ref: EngineCallRef): Promise<EngineCallSnapshot> {
    try {
      const call = await this.request<RetellCall>(
        'GET',
        `/v2/get-call/${encodeURIComponent(ref.callId)}`,
      );
      return snapshotOf(call, this.vendor, ref.callId);
    } catch (error) {
      if (error instanceof RetellHttpError && error.status === 404)
        return snapshotOf(null, this.vendor, ref.callId);
      return this.mapError(error, null);
    }
  }

  async findCallByIdempotencyKey(key: string): Promise<EngineCallSnapshot | null> {
    try {
      // The uncertain window is minutes; the most recent calls cover it. [VERIFY] a metadata
      // filter, if Retell offers one, would make this exact.
      const calls = await this.request<RetellCall[]>('POST', '/v2/list-calls', {
        sort_order: 'descending',
        limit: 1000,
      });
      const hit = calls.find((c) => c.metadata?.['idempotency_key'] === key);
      return hit === undefined ? null : snapshotOf(hit, this.vendor, hit.call_id);
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  async listNumbers(): Promise<readonly PhoneNumber[]> {
    try {
      const rows = await this.request<{ phone_number: string; inbound_agent_id?: string | null }[]>(
        'GET',
        '/list-phone-numbers',
      );
      return rows.map((r) => ({
        e164: r.phone_number,
        region: r.phone_number.startsWith('+44')
          ? 'GB'
          : r.phone_number.startsWith('+1')
            ? 'US'
            : 'ZZ',
        provider: 'retell',
        capabilities: { outbound: true, inbound: false },
      }));
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  async healthcheck(): Promise<HealthStatus> {
    try {
      await this.request('GET', '/list-phone-numbers');
      return { healthy: true };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : 'unknown' };
    }
  }

  // --- mid-call tools ----------------------------------------------------------------------------

  parseToolCall(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): ToolCallRequest {
    this.verify(headers, rawBody);
    const body = JSON.parse(rawBody.toString('utf8')) as RetellFunctionCall;
    const args = body.args ?? {};
    const callId = body.call.call_id;
    return {
      vendor: this.vendor,
      vendorCallId: callId,
      // Retell sends no invocation id [VERIFY]. A retry of one invocation repeats the name, the
      // arguments AND the conversation so far; a genuine second call with the same arguments
      // (lookup → verify_caller → lookup again) comes after more turns, so the id includes how
      // far the transcript had got. Without it the second lookup would replay the first one's
      // "needs verification" answer.
      toolCallId: createHash('sha256')
        .update(
          `${callId}\u0000${body.name}\u0000${JSON.stringify(args)}\u0000${String(turnsSoFar(body.call))}`,
        )
        .digest('hex')
        .slice(0, 32),
      tool: body.name,
      args,
      attemptId:
        typeof body.call.metadata?.['call_id'] === 'string' ? body.call.metadata['call_id'] : null,
    };
  }

  formatToolResult(result: ToolResult): EngineHttpResponse {
    // Retell hands the whole body to the model as the function result. A transfer target is a
    // staff number and never goes to the model — Retell could not dial it anyway.
    const action =
      result.action === null
        ? null
        : result.action.kind === 'transfer'
          ? { kind: 'transfer', supported: false }
          : result.action;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: result.ok, data: result.data, say: result.say, action }),
    };
  }

  // --- inbound: not supported (see the class comment) --------------------------------------------

  parseInboundRequest(): InboundCallRequest {
    throw new EngineUnavailable(this.vendor, 'inbound is not supported on retell (Q-31)');
  }

  formatInboundResponse(_decision: InboundDecision): EngineHttpResponse {
    throw new EngineUnavailable(this.vendor, 'inbound is not supported on retell (Q-31)');
  }

  private verify(headers: Readonly<Record<string, string | undefined>>, rawBody: Buffer): void {
    const header = headers[RETELL_SIGNATURE_HEADER] ?? headers['X-Retell-Signature'];
    if (!verifyRetell(this.options.apiKey, rawBody, header, this.now().getTime()))
      throw new SignatureInvalidError(this.vendor);
  }
}

/**
 * Our flat extraction schema → Retell post-call analysis fields. [VERIFY] field shapes.
 */
export function analysisFields(schema: Readonly<Record<string, unknown>>): unknown[] {
  const properties = (schema['properties'] ?? {}) as Record<
    string,
    { type?: string; enum?: string[] }
  >;
  return Object.entries(properties).map(([name, p]) =>
    p.enum !== undefined
      ? { type: 'enum', name, description: `The call's ${name}.`, choices: p.enum }
      : {
          type:
            p.type === 'boolean'
              ? 'boolean'
              : p.type === 'number' || p.type === 'integer'
                ? 'number'
                : 'string',
          name,
          description:
            name === 'confidence'
              ? 'How sure you are of the outcome, from 0 to 1.'
              : `The call's ${name.replace(/_/g, ' ')}, if there was one.`,
        },
  );
}

/** How many transcript turns the call had when the tool was invoked (0 when not sent). */
function turnsSoFar(call: RetellFunctionCall['call']): number {
  const t: unknown = call.transcript_object;
  return Array.isArray(t) ? t.length : 0;
}
