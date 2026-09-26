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
  type EngineHttpRequestInfo,
  type EngineHttpResponse,
  type HealthStatus,
  type InboundAttachment,
  type InboundCallRequest,
  type InboundDecision,
  type PhoneNumber,
  type PlaceCallRequest,
  type ToolCallRequest,
  type ToolResult,
  type WebCallRequest,
  type WebCallSession,
  type VoiceEngineAdapter,
} from '@naaradh/engines-core';
import { NaaradhError, SignatureInvalidError, isNaaradhError } from '@naaradh/shared';
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
 * Three things its documentation describes are implemented here and **switched off** until one
 * recorded call proves each (Q-31, the same discipline as BOLNA_INBOUND):
 *   inbound       RETELL_INBOUND. The inbound-call webhook arrives before the call is connected
 *                 and our reply decides it: `dynamic_variables` carry this call's prompt and
 *                 greeting, `metadata` carries our attempt id. `reject: true` exists and is
 *                 never used — a rejection is heard as a carrier failure, and E-92 says a
 *                 refusal must be spoken. A forward to the merchant's own number is only
 *                 reachable as a transfer (below); without it the caller hears the announcement
 *                 and the call ends.
 *   warmTransfer  RETELL_TRANSFER. The destination is a per-call variable that `prepareTransfer`
 *                 sets from the tenant's verified target, so the number never passes through
 *                 the model or the caller (invariant 19).
 *   cancel        RETELL_CANCEL. `POST /v2/stop-call` ends a call the order no longer needs
 *                 (E-40); a call Retell cannot find is treated as already over.
 *
 * What it still cannot do:
 *   AMD per call  voicemail detection is set on the agent; every Retell agent hangs up on a
 *                 machine, whatever the tenant's AMD mode (the safe choice; noted in Q-31).
 *
 * **Recordings expire.** Retell's `recording_url` is served for about ten minutes after the
 * call and then deleted, so the results worker persists it while handling `call_ended`
 * (`finalize.ts`) and a failed persist is recorded, never retried: by the time a retry ran the
 * audio would be gone. A call recovered later by the reconciler (E-21) may have no recording at
 * all, which is a fact about this vendor, not a bug.
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
  /**
   * The three capabilities Retell's documentation describes but nobody here has seen work
   * (Q-31). Each ships OFF and is switched on per environment once one recorded call proves it,
   * exactly as `BOLNA_INBOUND` does — the code below is written, not trusted.
   *
   *   inbound   RETELL_INBOUND   the inbound-call webhook answers with this call's prompt,
   *                              greeting and variables (`formatInboundResponse`).
   *   transfer  RETELL_TRANSFER  the agent's transfer destination is a per-call variable we set
   *                              from the verified target (`prepareTransfer`).
   *   cancel    RETELL_CANCEL    POST /v2/stop-call ends a call we no longer want (E-40).
   */
  readonly inbound?: boolean;
  readonly transfer?: boolean;
  readonly cancel?: boolean;
}

/**
 * The agent a number points at has a prompt and a greeting that are nothing but variables, so
 * the admission decision is what the agent becomes for that call. Same names as the Bolna
 * adapter; only the placeholder syntax differs (`{{x}}` here, `{x}` there).
 */
export const INBOUND_PROMPT_VAR = 'naaradh_system_prompt';
export const INBOUND_GREETING_VAR = 'naaradh_first_utterance';
/** Where a transfer goes, set per call from a verified target — never from the model. */
export const TRANSFER_TO_VAR = 'naaradh_transfer_to';

const CLOSED_PROMPT =
  'The opening line has already told the caller everything. Say nothing more. End the call now.';

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
      inbound: this.options.inbound === true,
      cancel: this.options.cancel === true,
      warmTransfer: this.options.transfer === true,
      midCallTools: true,
      // Q-04: never from documentation — flip only after an invoice shows per-second billing.
      perSecondBilling: false,
      recordingToggle: false,
      signedWebhooks: true,
      reportsDisclosure: false,
      progressEvents: true,
      callLookup: true,
      // /v3/create-web-call: no number, no carrier. [VERIFY] with one browser call.
      webCall: true,
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
    // 204 and an empty body are success with nothing to read (stop-call).
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
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
  ): EngineEvent | null {
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
    // staff number and never goes to the model: the destination was set on the call itself by
    // `prepareTransfer`, and the agent's transfer tool reads it from there. All the model is
    // told is whether transferring is possible at all.
    const action =
      result.action === null
        ? null
        : result.action.kind === 'transfer'
          ? { kind: 'transfer', supported: this.capabilities().warmTransfer }
          : result.action;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: result.ok, data: result.data, say: result.say, action }),
    };
  }

  // --- inbound (Q-31, RETELL_INBOUND) ----------------------------------------------------------

  /**
   * Point one of our numbers at our inbound-context URL and give it an agent whose prompt and
   * greeting are pure variables. Retell asks that URL on every call, so what the agent says is
   * decided per call by `admitInbound()`, never by what is stored on the agent.
   *
   * [VERIFY] `inbound_webhook_url` and `inbound_agent_id` on update-phone-number.
   */
  async attachInboundNumber(input: InboundAttachment): Promise<EngineAgentRef> {
    if (!this.capabilities().inbound)
      throw new EngineUnavailable(this.vendor, 'inbound is switched off (RETELL_INBOUND)');
    try {
      const llm = await this.request<{ llm_id: string }>(
        'POST',
        '/create-retell-llm',
        this.llmBody({
          ...input.agent,
          systemPrompt: `{{${INBOUND_PROMPT_VAR}}}`,
          firstUtterance: `{{${INBOUND_GREETING_VAR}}}`,
        }),
      );
      const agent = await this.request<{ agent_id: string }>(
        'POST',
        '/create-agent',
        this.agentBody(input.agent, llm.llm_id),
      );
      await this.request('PATCH', `/update-phone-number/${encodeURIComponent(input.e164)}`, {
        inbound_agent_id: agent.agent_id,
        inbound_webhook_url: input.inboundUrl,
      });
      return { vendor: this.vendor, agentId: agent.agent_id };
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  /**
   * Retell POSTs before the call is connected and before a call object exists, so `call_id` here
   * is preallocated and repeats across its retries — it is the de-duplication key.
   *
   * Invariant 16: the tenant comes from the number that was called, and the only number we
   * trust is the one WE bound into this URL at attach time. Retell's `to_number` is checked
   * against it and a mismatch is refused rather than reconciled.
   *
   * [VERIFY] the `call_inbound` envelope against a recorded delivery.
   */
  parseInboundRequest(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
    http?: EngineHttpRequestInfo,
  ): InboundCallRequest {
    if (!this.capabilities().inbound)
      throw new EngineUnavailable(this.vendor, 'inbound is switched off (RETELL_INBOUND)');
    this.verify(headers, rawBody);
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      call_inbound?: {
        call_id?: string;
        from_number?: string | null;
        to_number?: string | null;
        event_timestamp?: number | null;
      };
    };
    const inbound = body.call_inbound;
    if (inbound === undefined) throw new Error('retell inbound webhook without call_inbound');

    const bound = http?.boundCalledE164;
    const claimed = (inbound.to_number ?? '').trim();
    if (bound === undefined) throw new Error('retell inbound lookup without a bound number');
    if (claimed !== '' && claimed !== bound)
      throw new Error('retell inbound webhook names a number this URL was not minted for');

    const caller = (inbound.from_number ?? '').trim();
    // Preallocated and stable across Retell's 3 attempts, so a retry is one call, not three.
    // Without it there is nothing to de-duplicate on, and admission would run twice.
    const callId = (inbound.call_id ?? '').trim();
    if (callId === '') throw new Error('retell inbound webhook without a call_id');

    return {
      vendor: this.vendor,
      vendorCallId: callId,
      calledE164: bound,
      // E-80: withheld or anonymous arrives as an empty or non-E.164 value.
      callerE164: /^\+[1-9]\d{7,14}$/.test(caller) ? caller : null,
      at:
        typeof inbound.event_timestamp === 'number'
          ? new Date(inbound.event_timestamp)
          : this.now(),
    };
  }

  /**
   * Our decision in Retell's response shape. `reject: true` exists and is deliberately never
   * used: a rejected call is a SIP failure the caller hears as dead air or a carrier message,
   * and E-92 says a refusal must always be spoken. So every decision answers the call —
   * the difference is only what the agent is told to say.
   */
  formatInboundResponse(decision: InboundDecision): EngineHttpResponse {
    if (!this.capabilities().inbound)
      throw new EngineUnavailable(this.vendor, 'inbound is switched off (RETELL_INBOUND)');
    const variables: Record<string, string> =
      decision.kind === 'answer'
        ? {
            ...decision.variables,
            [INBOUND_PROMPT_VAR]: decision.systemPrompt,
            [INBOUND_GREETING_VAR]: decision.firstUtterance,
          }
        : {
            [INBOUND_PROMPT_VAR]: CLOSED_PROMPT,
            [INBOUND_GREETING_VAR]:
              decision.kind === 'closed'
                ? decision.message
                : (decision.announcement ??
                  'Sorry, we cannot take your call right now. Please call again shortly.'),
          };
    // A forward is a transfer to the merchant's own number, which this engine can only do from
    // a per-call variable — and only when transfers are switched on. Otherwise the caller hears
    // the announcement and the call ends there (the same degradation as Bolna, Q-31/Q-34).
    if (decision.kind === 'forward' && this.capabilities().warmTransfer)
      variables[TRANSFER_TO_VAR] = decision.toE164;

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        call_inbound: {
          dynamic_variables: variables,
          ...(decision.kind === 'answer'
            ? { metadata: { call_id: decision.attemptId } }
            : { metadata: { naaradh_refused: decision.kind } }),
        },
      }),
    };
  }

  // --- web call --------------------------------------------------------------------------------

  /**
   * A call the merchant hears in their own browser: no number, no carrier, no DLT, nothing
   * dialled. It exists so someone can hear their agent — the real script, the real voice, the
   * real tools — before a phone number exists anywhere.
   *
   * The disclosure is unchanged: the agent's greeting is the approved first utterance, so the
   * caller hears the AI and recording notice exactly as a customer would (invariant 7). Nothing
   * about it is billable: no outcome, no minutes, no usage record.
   *
   * `/v3/create-web-call` — v2 is on Retell's deprecation list. [VERIFY] the response shape
   * with one browser call (go-live 10 §5).
   */
  async createWebCall(req: WebCallRequest): Promise<WebCallSession> {
    if (!this.capabilities().webCall)
      throw new EngineUnavailable(this.vendor, 'web calls are not available on this engine');
    try {
      const res = await this.request<{
        call_id: string;
        access_token: string;
        expires_at?: number | null;
      }>('POST', '/v3/create-web-call', {
        agent_id: req.agentRef.agentId,
        retell_llm_dynamic_variables: req.variables,
        metadata: req.metadata,
      });
      return {
        vendor: this.vendor,
        callId: res.call_id,
        accessToken: res.access_token,
        // Retell states an expiry; if a version stops sending one, treat the token as short-lived
        // rather than eternal — it is a credential either way.
        expiresAt: new Date(
          typeof res.expires_at === 'number' ? res.expires_at : this.now().getTime() + 60_000,
        ),
      };
    } catch (error) {
      return this.mapError(error, null);
    }
  }

  // --- cancel (Q-31, RETELL_CANCEL) ------------------------------------------------------------

  /**
   * E-40: the order was cancelled while we were ringing. Retell documents stop-call for "an
   * ongoing call" and does not say which states qualify, so a call it cannot find is treated as
   * already over rather than as an error — the outcome is the same and the dispatcher must not
   * retry a cancel for ever.
   */
  async cancelCall(ref: EngineCallRef): Promise<void> {
    if (!this.capabilities().cancel)
      throw new EngineUnavailable(this.vendor, 'cancel is switched off (RETELL_CANCEL)');
    try {
      await this.request('POST', `/v2/stop-call/${encodeURIComponent(ref.callId)}`);
    } catch (error) {
      if (alreadyOver(error)) return;
      return this.mapError(error, ref.callId);
    }
  }

  // --- transfer (Q-31, RETELL_TRANSFER) --------------------------------------------------------

  /**
   * Set this call's transfer destination just before the tool result that asks for it. The
   * agent's transfer tool dials `{{naaradh_transfer_to}}`, so the number comes from our verified
   * targets and never from the model or the caller (invariant 19). The whisper summary rides
   * along as context for the same turn.
   *
   * [VERIFY] update-live-call's `fields_to_override` / `call_control` shape.
   */
  async prepareTransfer(
    ref: EngineCallRef,
    toE164: string,
    warmSummary: string | null,
  ): Promise<void> {
    if (!this.capabilities().warmTransfer)
      throw new EngineUnavailable(this.vendor, 'transfer is switched off (RETELL_TRANSFER)');
    try {
      await this.request('PATCH', `/v2/update-live-call/${encodeURIComponent(ref.callId)}`, {
        fields_to_override: { override_dynamic_variables: { [TRANSFER_TO_VAR]: toE164 } },
        ...(warmSummary === null ? {} : { call_control: { additional_context: warmSummary } }),
      });
    } catch (error) {
      return this.mapError(error, ref.callId);
    }
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

/**
 * A stop-call Retell could not act on because the call is not there: 404, or the 422 its
 * documentation gives for "call not found under this API key". Either way the call is over,
 * which is what the caller of `cancelCall` wanted (E-40).
 */
function alreadyOver(error: unknown): boolean {
  if (error instanceof RetellHttpError) return error.status === 404 || error.status === 422;
  const status = isNaaradhError(error) ? error.context['status'] : undefined;
  return status === 404 || status === 422;
}
