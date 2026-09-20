import { createHash, timingSafeEqual } from 'node:crypto';
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
  type EngineHttpRequestInfo,
  type EngineHttpResponse,
  type HealthStatus,
  type InboundAttachment,
  type InboundCallRequest,
  type InboundDecision,
  type PhoneNumber,
  type PlaceCallRequest,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolResult,
  type VoiceEngineAdapter,
} from '@naaradh/engines-core';
import { NaaradhError, SignatureInvalidError } from '@naaradh/shared';
import { attemptIdOf, mapWebhook, snapshotOf } from './map-events.js';
import type { BolnaExecution } from './wire.js';

export {
  mapWebhook,
  snapshotOf,
  connected,
  answeredBy,
  endReason,
  extractedOf,
} from './map-events.js';
export type { BolnaExecution, BolnaTelephony } from './wire.js';

/**
 * Bolna — the India primary candidate (ADR-0001; P1-ENG-3). HTTP over `fetch`, no vendor SDK.
 * Bolna rents the STT, LLM and TTS and dials through the telephony account connected to it
 * (Plivo / Exotel / Twilio / Vobiz numbers — never a foreign CLI into India).
 *
 * How Bolna differs from the contract's happy path, and what the adapter does about it:
 *
 *   unsigned webhooks   Bolna signs nothing; it publishes three source IPs (allow-listed at the
 *                       edge, `engine_ip_allowlist`). Every event is a hint and the outcome is
 *                       written from `fetchCall()` (E-23) — `signedWebhooks: false`.
 *   no idempotency key  ours rides in `user_data`; the UNCERTAIN path finds the call by reading
 *                       recent executions back (`findCallByIdempotencyKey`).
 *   tools               a "custom function" is an HTTP call Bolna makes to OUR url with a static
 *                       bearer token (`BOLNA_TOOL_TOKEN`) — that token, plus the tenant tag in
 *                       the URL, is the authentication. Without the token, `midCallTools` is off.
 *   transfer            only to a number fixed on the agent; ours are chosen per call from
 *                       verified targets (invariant 19) → `warmTransfer: false`, a transfer
 *                       request becomes a callback ticket.
 *   inbound             a number is linked to ONE agent; per call Bolna asks our URL for the
 *                       caller's data. We make that agent's prompt and greeting pure variables
 *                       and answer with the admission decision, so the tenant still comes only
 *                       from the called number (bound, signed, into that URL at provisioning).
 *                       A refusal speaks the closed message; Bolna cannot forward to a number
 *                       chosen per call (Q-34). Off until verified: `BOLNA_INBOUND=true`.
 *
 * Every wire detail is from Bolna's published API reference and marked [VERIFY]; go-live 03
 * records real payloads and replaces the fixtures.
 */

export interface BolnaVoice {
  readonly provider: string;
  readonly voice: string;
  readonly voice_id: string;
  readonly model: string;
  /** Required by most TTS providers (sarvam, cartesia, polly…), refused by elevenlabs. */
  readonly language?: string;
}

export interface BolnaOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** The bearer Bolna presents on tool calls and inbound lookups (≥ 32 chars). */
  readonly toolToken?: string | undefined;
  /** Inbound stays off until the variable-prompt design is seen working on a real call. */
  readonly inboundEnabled?: boolean;
  /** The telephony account connected to Bolna: plivo | exotel | twilio | vobiz | sip-trunk. */
  readonly telephonyProvider?: string;
  readonly llm?: { readonly provider: string; readonly model: string };
  /** Voice per locale for AgentSpec.voiceId 'default'. [VERIFY] ids from Bolna's List voices. */
  readonly voices?: Readonly<Record<string, BolnaVoice>>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_VOICE: BolnaVoice = {
  provider: 'elevenlabs',
  voice: 'Angelica',
  voice_id: 'IkSv4tkouLJ6kYsQA7XD',
  model: 'eleven_turbo_v2_5',
};

/** Keys we add to a tool's arguments; never passed to the tool handler. */
const RESERVED_ARGS = new Set(['execution_id', 'naaradh_attempt_id']);

export const INBOUND_PROMPT_VAR = 'naaradh_system_prompt';
export const INBOUND_GREETING_VAR = 'naaradh_first_utterance';

const CLOSED_PROMPT =
  'The opening line has already told the caller everything. Say nothing more. End the call now.';

class BolnaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSec: number,
  ) {
    super(`bolna HTTP ${String(status)}`);
  }
}

export class BolnaAdapter implements VoiceEngineAdapter {
  readonly vendor = 'bolna';
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: BolnaOptions) {
    this.base = options.baseUrl ?? 'https://api.bolna.ai';
    this.doFetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  capabilities(): EngineCapabilities {
    const tools = (this.options.toolToken ?? '').length >= 32;
    return {
      inbound: tools && this.options.inboundEnabled === true,
      cancel: true,
      warmTransfer: false,
      midCallTools: tools,
      // Q-04: never from documentation — flip only after an invoice shows per-second billing.
      perSecondBilling: false,
      recordingToggle: false,
      signedWebhooks: false,
      reportsDisclosure: false,
      progressEvents: true,
      callLookup: true,
    };
  }

  /** Bolna serves recordings from its own API host, behind the API key. [VERIFY] */
  recordingRequestHeaders(url: string): Readonly<Record<string, string>> {
    try {
      return new URL(url).origin === new URL(this.base).origin
        ? { authorization: `Bearer ${this.options.apiKey}` }
        : {};
    } catch {
      return {};
    }
  }

  // --- HTTP ------------------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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
      throw new BolnaHttpError(res.status, Number.isFinite(retry) && retry > 0 ? retry : 5);
    }
    if (res.status === 404) throw new BolnaHttpError(404, 0);
    if (!res.ok) {
      // Our request was wrong (a caller ID not on the account, a bad agent): not retryable.
      throw new NaaradhError('INTERNAL', `bolna rejected ${method} ${path.split('/')[1] ?? ''}`, {
        context: { vendor: this.vendor, status: res.status },
        retryable: false,
      });
    }
    return (await res.json()) as T;
  }

  /** Maps transport failures to the three errors the dispatcher distinguishes (AGENTS §5.3). */
  private mapError(error: unknown, idempotencyKey: string | null): never {
    if (error instanceof NaaradhError) throw error;
    if (error instanceof BolnaHttpError) {
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

  private agentBody(
    spec: AgentSpec,
    extra: { readonly ingest?: { readonly url: string } } = {},
  ): Record<string, unknown> {
    const lang = spec.locale.slice(0, 2);
    const voice =
      spec.voiceId !== 'default'
        ? { ...DEFAULT_VOICE, voice: spec.voiceId, voice_id: spec.voiceId }
        : ((this.options.voices ?? {})[spec.locale] ?? DEFAULT_VOICE);
    const { language: voiceLanguage, ...voiceConfig } = voice;
    const telephony = this.options.telephonyProvider ?? 'plivo';
    const format = telephony === 'twilio' || telephony === 'sip-trunk' ? 'ulaw' : 'wav';
    const tools = this.capabilities().midCallTools ? (spec.tools ?? []) : [];
    return {
      agent_config: {
        agent_name: spec.name.slice(0, 120),
        // `{slot}` placeholders are filled per call from user_data.
        agent_welcome_message: spec.firstUtterance,
        agent_type: 'other',
        ...(spec.webhookUrl === undefined ? {} : { webhook_url: spec.webhookUrl }),
        ...(extra.ingest === undefined
          ? {}
          : {
              ingest_source_config: {
                source_type: 'api',
                source_url: extra.ingest.url,
                source_auth_token: this.options.toolToken ?? '',
              },
            }),
        tasks: [
          {
            task_type: 'conversation',
            toolchain: {
              execution: 'sequential',
              pipelines: [['transcriber', 'llm', 'synthesizer']],
            },
            tools_config: {
              llm_agent: {
                agent_type: 'simple_llm_agent',
                agent_flow_type: 'streaming',
                llm_config: {
                  provider: this.options.llm?.provider ?? 'openai',
                  model: this.options.llm?.model ?? 'gpt-4.1-mini',
                  max_tokens: 200,
                  temperature: 0.2,
                },
              },
              synthesizer: {
                provider: voice.provider,
                provider_config: {
                  ...voiceConfig,
                  ...(voiceLanguage === undefined ? {} : { language: voiceLanguage }),
                },
                stream: true,
                buffer_size: 250,
                audio_format: 'wav',
              },
              transcriber: {
                provider: 'deepgram',
                model: 'nova-3',
                // Plain ISO 639-1: Bolna refuses `hi-IN`.
                language: lang,
                stream: true,
                encoding: 'linear16',
                sampling_rate: 16_000,
                endpointing: 250,
              },
              input: { provider: telephony, format },
              output: { provider: telephony, format },
              api_tools:
                tools.length === 0
                  ? null
                  : {
                      tools: tools.map((t) => this.toolBody(t)),
                      tools_params: Object.fromEntries(
                        tools.map((t) => [t.name, this.toolBody(t).value]),
                      ),
                    },
            },
            task_config: {
              call_terminate: spec.maxDurationSec,
              hangup_after_silence: 10,
              // A voicemail is never talked to (E-24).
              voicemail: true,
            },
          },
        ],
      },
      agent_prompts: { task_1: { system_prompt: spec.systemPrompt } },
    };
  }

  /** One of our tools as a Bolna "custom function": the schema for the LLM + how to call us. */
  private toolBody(t: ToolDefinition) {
    const schema = t.parameters as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    const properties = schema.properties ?? {};
    const param: Record<string, string> = {
      // System variables Bolna fills itself: which call this is. [VERIFY]
      execution_id: '%(execution_id)s',
      naaradh_attempt_id: '%(naaradh_attempt_id)s',
    };
    for (const [name, p] of Object.entries(properties)) {
      // Bolna substitutes into a template, so every value can arrive as a string; the key's
      // suffix tells parseToolCall what it was meant to be.
      if (p.type === 'integer') param[`${name}__i`] = `%(${name})i`;
      else if (p.type === 'number') param[`${name}__f`] = `%(${name})f`;
      else if (p.type === 'boolean') param[`${name}__b`] = `%(${name})s`;
      else param[name] = `%(${name})s`;
    }
    return {
      name: t.name,
      description: t.description,
      ...(t.fillerUtterance === null ? {} : { pre_call_message: t.fillerUtterance }),
      parameters: {
        type: 'object',
        properties: {
          ...properties,
          execution_id: { type: 'string', description: 'The id of this call. Filled in for you.' },
          naaradh_attempt_id: { type: 'string', description: 'Filled in for you.' },
        },
        required: schema.required ?? [],
      },
      key: 'custom_task',
      value: {
        method: 'POST',
        url: t.url,
        api_token: `Bearer ${this.options.toolToken ?? ''}`,
        headers: { 'content-type': 'application/json' },
        param,
      },
    };
  }

  /** Post-call extraction: one Bolna "disposition" per field of our flat result schema. */
  private async setExtraction(agentId: string, spec: AgentSpec): Promise<void> {
    if (spec.extraction === undefined) return;
    const dispositions = dispositionsFor(spec.extraction.schema);
    if (dispositions.length === 0) return;
    await this.request('POST', '/dispositions/bulk', { agent_id: agentId, dispositions });
  }

  async createAgent(spec: AgentSpec): Promise<EngineAgentRef> {
    try {
      const agent = await this.request<{ agent_id: string }>(
        'POST',
        '/v2/agent',
        this.agentBody(spec),
      );
      await this.setExtraction(agent.agent_id, spec);
      return { vendor: this.vendor, agentId: agent.agent_id };
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  async updateAgent(ref: EngineAgentRef, spec: AgentSpec): Promise<void> {
    try {
      // Dispositions are set at creation; a changed result schema is a new script version and
      // therefore a new agent (the dispatcher keys agents by script version).
      await this.request(
        'PUT',
        `/v2/agent/${encodeURIComponent(ref.agentId)}`,
        this.agentBody(spec),
      );
    } catch (error) {
      this.mapError(error, null);
    }
  }

  // --- calls -----------------------------------------------------------------------------------

  async placeCall(req: PlaceCallRequest): Promise<EngineCallRef> {
    try {
      const res = await this.request<{ execution_id: string }>('POST', '/call', {
        agent_id: req.agentRef.agentId,
        recipient_phone_number: req.to,
        from_phone_number: req.from,
        // DATA for the `{slot}`s (E-72), plus what lets us find this call again: Bolna has no
        // idempotency key and no metadata field, and echoes user_data back on the execution.
        user_data: {
          ...req.variables,
          naaradh_attempt_id: req.metadata.call_id,
          naaradh_idempotency_key: req.idempotencyKey,
        },
        // Our gate has already decided the calling window in the recipient's zone (invariant
        // 3); Bolna's own guardrails must never reschedule a call to a time we did not approve.
        bypass_call_guardrails: true,
      });
      return { vendor: this.vendor, callId: res.execution_id };
    } catch (error) {
      return this.mapError(error, req.idempotencyKey);
    }
  }

  /** Only a queued or scheduled call can be stopped; a ringing one runs its course (E-40). */
  async cancelCall(ref: EngineCallRef): Promise<void> {
    try {
      await this.request('POST', `/call/${encodeURIComponent(ref.callId)}/stop`);
    } catch (error) {
      if (error instanceof BolnaHttpError && error.status === 404) return;
      // 400 = already dialling: nothing to stop. The results path marks it superseded.
      if (error instanceof NaaradhError && error.code === 'INTERNAL') return;
      this.mapError(error, null);
    }
  }

  parseWebhook(
    _headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): EngineEvent | null {
    // Nothing to verify: Bolna does not sign (see the class comment). The URL's tenant tag was
    // checked by the route, and nothing here is believed until fetchCall() confirms it.
    const body = JSON.parse(rawBody.toString('utf8')) as BolnaExecution;
    return mapWebhook(body, this.vendor, this.now());
  }

  async fetchCall(ref: EngineCallRef): Promise<EngineCallSnapshot> {
    try {
      const x = await this.request<BolnaExecution>(
        'GET',
        `/executions/${encodeURIComponent(ref.callId)}`,
      );
      return snapshotOf(x, this.vendor, ref.callId);
    } catch (error) {
      if (error instanceof BolnaHttpError && error.status === 404)
        return snapshotOf(null, this.vendor, ref.callId);
      return this.mapError(error, null);
    }
  }

  /**
   * Bolna cannot look a call up by anything we sent, and its lists are trimmed (no user_data).
   * So: every agent's most recent executions, newest first, fetched one by one until the key
   * turns up — bounded, because the uncertain window is minutes and this path is rare.
   */
  async findCallByIdempotencyKey(key: string): Promise<EngineCallSnapshot | null> {
    try {
      const since = this.now().getTime() - 30 * 60_000;
      const agents = await this.request<{ id: string }[]>('GET', '/v2/agent/all');
      let budget = 80;
      for (const agent of agents) {
        if (budget <= 0) break;
        const page = await this.request<{ data?: BolnaExecution[] } | BolnaExecution[]>(
          'GET',
          `/v2/agent/${encodeURIComponent(agent.id)}/executions?page_number=1&page_size=20`,
        );
        budget -= 1;
        const rows = Array.isArray(page) ? page : (page.data ?? []);
        for (const row of rows) {
          const created = Date.parse(row.created_at ?? '');
          if (!Number.isNaN(created) && created < since) break;
          if (budget <= 0) break;
          budget -= 1;
          const full = await this.request<BolnaExecution>(
            'GET',
            `/executions/${encodeURIComponent(row.id)}`,
          );
          if (full.context_details?.recipient_data?.['naaradh_idempotency_key'] === key)
            return snapshotOf(full, this.vendor, full.id);
        }
      }
      return null;
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  private async numbers(): Promise<
    { id: string; phone_number: string; telephony_provider?: string | null }[]
  > {
    return this.request('GET', '/phone-numbers/all');
  }

  async listNumbers(): Promise<readonly PhoneNumber[]> {
    try {
      return (await this.numbers()).map((r) => ({
        e164: r.phone_number,
        region: r.phone_number.startsWith('+91') ? 'IN' : 'ZZ',
        provider: r.telephony_provider ?? 'bolna',
        capabilities: { outbound: true, inbound: this.capabilities().inbound },
      }));
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  async healthcheck(): Promise<HealthStatus> {
    try {
      await this.numbers();
      return { healthy: true };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : 'unknown' };
    }
  }

  // --- mid-call tools ----------------------------------------------------------------------------

  /** The static bearer we gave Bolna for this tool / lookup, compared in constant time. */
  private verifyToken(headers: Readonly<Record<string, string | undefined>>): void {
    const token = this.options.toolToken ?? '';
    const given = Buffer.from(headers['authorization'] ?? headers['Authorization'] ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (token.length < 32 || given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new SignatureInvalidError(this.vendor);
  }

  parseToolCall(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
    http?: EngineHttpRequestInfo,
  ): ToolCallRequest {
    this.verifyToken(headers);
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const callId = body['execution_id'];
    if (typeof callId !== 'string' || callId === '' || callId.startsWith('%('))
      throw new Error('bolna tool call without execution_id');
    // The tool's name exists only in the URL we gave Bolna for it.
    const tool = http?.path.split('/').filter(Boolean).at(-1) ?? '';
    const args = toolArgs(body);
    const attemptId = body['naaradh_attempt_id'];
    return {
      vendor: this.vendor,
      vendorCallId: callId,
      // Bolna sends no invocation id [VERIFY]. A retry of one invocation comes within seconds
      // with the same arguments; the same arguments again later in the call (lookup → verify →
      // lookup) are a new invocation and must not replay the first answer.
      toolCallId: createHash('sha256')
        .update(
          `${callId} ${tool} ${JSON.stringify(args)} ${String(Math.floor(this.now().getTime() / 5_000))}`,
        )
        .digest('hex')
        .slice(0, 32),
      tool,
      args,
      attemptId: typeof attemptId === 'string' && attemptId.startsWith('att_') ? attemptId : null,
    };
  }

  formatToolResult(result: ToolResult): EngineHttpResponse {
    // Bolna hands the whole body to the model as the function result. A transfer target is a
    // staff number and never goes to the model — Bolna could not dial it anyway.
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

  // --- inbound -----------------------------------------------------------------------------------

  /**
   * Links one of our numbers to a new Bolna agent whose prompt and greeting are variables, and
   * points Bolna's per-call caller lookup at `inboundUrl` (which carries the called number,
   * signed by us). Provisioning, not per call.
   */
  async attachInboundNumber(input: InboundAttachment): Promise<EngineAgentRef> {
    if (!this.capabilities().inbound)
      throw new EngineUnavailable(this.vendor, 'inbound is switched off (BOLNA_INBOUND)');
    try {
      const number = (await this.numbers()).find((n) => n.phone_number === input.e164);
      if (number === undefined)
        throw new NaaradhError('NOT_FOUND', 'the number is not on the bolna account', {
          context: { vendor: this.vendor },
        });
      const agent = await this.request<{ agent_id: string }>(
        'POST',
        '/v2/agent',
        this.agentBody(
          {
            ...input.agent,
            systemPrompt: `{${INBOUND_PROMPT_VAR}}`,
            firstUtterance: `{${INBOUND_GREETING_VAR}}`,
          },
          { ingest: { url: input.inboundUrl } },
        ),
      );
      await this.request('POST', '/inbound/setup', {
        agent_id: agent.agent_id,
        phone_number_id: number.id,
      });
      return { vendor: this.vendor, agentId: agent.agent_id };
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  parseInboundRequest(
    headers: Readonly<Record<string, string | undefined>>,
    _rawBody: Buffer,
    http?: EngineHttpRequestInfo,
  ): InboundCallRequest {
    if (!this.capabilities().inbound)
      throw new EngineUnavailable(this.vendor, 'inbound is switched off (BOLNA_INBOUND)');
    this.verifyToken(headers);
    const called = http?.boundCalledE164;
    const callId = http?.query['execution_id'];
    // Invariant 16: the tenant comes only from the number that was called — here, the number
    // WE bound into this URL when the number was attached, verified by the route.
    if (called === undefined || callId === undefined || callId === '')
      throw new Error('bolna inbound lookup without a bound number or execution_id');
    // A `+` in a query string decodes to a space.
    const caller = (http?.query['contact_number'] ?? '').trim().replace(/^(?=\d)/, '+');
    return {
      vendor: this.vendor,
      vendorCallId: callId,
      calledE164: called,
      callerE164: /^\+[1-9]\d{7,14}$/.test(caller) ? caller : null,
      at: this.now(),
    };
  }

  formatInboundResponse(decision: InboundDecision): EngineHttpResponse {
    // Bolna injects this JSON into the agent's variables: the prompt and the greeting ARE two
    // of them, so the admission decision is what the agent becomes for this call.
    const body =
      decision.kind === 'answer'
        ? {
            ...decision.variables,
            [INBOUND_PROMPT_VAR]: decision.systemPrompt,
            [INBOUND_GREETING_VAR]: decision.firstUtterance,
            naaradh_attempt_id: decision.attemptId,
          }
        : {
            [INBOUND_PROMPT_VAR]: CLOSED_PROMPT,
            // Never dead air (E-92). A forward to the merchant's own number cannot be expressed
            // to Bolna per call (Q-34): the caller hears why and the closed message instead.
            [INBOUND_GREETING_VAR]:
              decision.kind === 'closed'
                ? decision.message
                : (decision.announcement ??
                  'Sorry, we cannot take your call right now. Please call again shortly.'),
          };
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }
}

/** A scalar as text; anything else (an object where text was expected) as nothing. */
const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

/** A tool call body → the arguments the handler sees, with the typed keys coerced back. */
function toolArgs(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(body)) {
    if (RESERVED_ARGS.has(rawKey)) continue;
    // An optional argument the model did not give: Python's None, or the template untouched.
    if (value === null || value === 'None' || value === '') continue;
    if (typeof value === 'string' && value.startsWith('%(')) continue;
    const m = /^(.*)__([ifb])$/.exec(rawKey);
    if (m === null) {
      args[rawKey] = value;
      continue;
    }
    const key = m[1] ?? rawKey;
    if (m[2] === 'b') args[key] = typeof value === 'boolean' ? value : /^true$/i.test(text(value));
    else {
      const n = Number(value);
      if (Number.isFinite(n)) args[key] = m[2] === 'i' ? Math.trunc(n) : n;
    }
  }
  return args;
}

/** Our flat extraction schema → Bolna dispositions, all in one category. [VERIFY] shapes. */
export function dispositionsFor(schema: Readonly<Record<string, unknown>>): unknown[] {
  const properties = (schema['properties'] ?? {}) as Record<
    string,
    { type?: string; enum?: string[] }
  >;
  return Object.entries(properties).map(([name, p]) => {
    // Bolna returns every answer as text: the suffix says what to turn it back into
    // (map-events.ts extractedOf).
    const suffix =
      p.type === 'integer'
        ? '__i'
        : p.type === 'number'
          ? '__f'
          : p.type === 'boolean'
            ? '__b'
            : '';
    const base = { name: `${name}${suffix}`, category: 'Naaradh' };
    if (p.enum !== undefined)
      return {
        ...base,
        question: `What was the call's ${name.replace(/_/g, ' ')}? Choose exactly one.`,
        is_objective: true,
        objective_options: p.enum.map((value) => ({
          value,
          condition: `The call's ${name.replace(/_/g, ' ')} is "${value.replace(/_/g, ' ')}".`,
        })),
      };
    const numeric = p.type === 'number' || p.type === 'integer';
    return {
      ...base,
      question:
        name === 'confidence'
          ? 'How sure are you of the outcome, from 0 to 1?'
          : `The call's ${name.replace(/_/g, ' ')}, if there was one.`,
      is_subjective: true,
      subjective_type: p.type === 'boolean' ? 'boolean' : numeric ? 'numeric' : 'text',
    };
  });
}

export { attemptIdOf };
