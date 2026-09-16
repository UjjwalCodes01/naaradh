import { createHmac, randomBytes } from 'node:crypto';
import { SignatureInvalidError, sha256Hex, timingSafeEqualString } from '@naaradh/shared';
import { assertFakePhone } from '@naaradh/shared/test/fake-phones';
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
  type EndReason,
  type HealthStatus,
  type InboundCallRequest,
  type InboundDecision,
  type Locale,
  type PhoneNumber,
  type PlaceCallRequest,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolResult,
  type VoiceEngineAdapter,
} from '@naaradh/engines-core';

/**
 * Deterministic scripted engine for every CI run and for `pnpm dev`.
 *
 * Two non-negotiables:
 *   1. `placeCall` refuses any `to` outside the reserved fake ranges. This is the last line
 *      between a test run and a real phone ringing.
 *   2. Every scenario is fixed, including the nasty ones — duplicate webhook, out-of-order
 *      webhook, missing webhook, unsigned webhook, 429, 5xx, timeout-after-send. The
 *      dispatcher and results-consumer are tested against these, not against happy paths.
 *
 * Scenario selection: `variables.__scenario` if set, else by the `to` number's last three
 * digits (see SCENARIO_BY_SUFFIX), else 'answered-human-confirmed'.
 *
 * Events are emitted as SIGNED WEBHOOK PAYLOADS through the sink, so the same hooks →
 * Pub/Sub → results-consumer pipeline runs in tests as in production.
 */

export type ScenarioName =
  | 'answered-human-confirmed'
  | 'answered-human-cancelled'
  | 'answered-machine'
  | 'no-answer'
  | 'busy'
  | 'transfer-success'
  | 'transfer-fail'
  | 'opt-out-mid-call'
  | 'wrong-number'
  | 'minor-answered'
  | 'pocket-answer'
  | 'webhook-duplicate'
  | 'webhook-out-of-order'
  | 'webhook-missing'
  | 'unsigned-webhook'
  | 'rate-limited'
  | 'engine-5xx'
  | 'timeout-uncertain'
  | 'invalid-number';

export const SCENARIOS: readonly ScenarioName[] = [
  'answered-human-confirmed',
  'answered-human-cancelled',
  'answered-machine',
  'no-answer',
  'busy',
  'transfer-success',
  'transfer-fail',
  'opt-out-mid-call',
  'wrong-number',
  'minor-answered',
  'pocket-answer',
  'webhook-duplicate',
  'webhook-out-of-order',
  'webhook-missing',
  'unsigned-webhook',
  'rate-limited',
  'engine-5xx',
  'timeout-uncertain',
  'invalid-number',
];

/** Last three digits of the fake number → scenario, matching FAKE_IN in fake-phones.ts. */
export const SCENARIO_BY_SUFFIX: Readonly<Record<string, ScenarioName>> = {
  '001': 'answered-human-confirmed',
  '002': 'answered-human-cancelled',
  '003': 'answered-machine',
  '004': 'no-answer',
  '005': 'busy',
  '006': 'transfer-success',
  '007': 'transfer-fail',
  '010': 'opt-out-mid-call',
  '012': 'invalid-number',
  '013': 'minor-answered',
  '020': 'pocket-answer',
  '021': 'wrong-number',
  '030': 'webhook-duplicate',
  '031': 'webhook-out-of-order',
  '032': 'webhook-missing',
  '033': 'unsigned-webhook',
  '040': 'rate-limited',
  '041': 'engine-5xx',
  '042': 'timeout-uncertain',
};

export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Buffer;
}

export interface SimulatorOptions {
  /** HMAC secret for `x-sim-signature`. Tests share it with the hooks service. */
  readonly webhookSecret: string;
  /** Receives every webhook the "vendor" would POST. Default: buffered in `outbox`. */
  readonly sink?: (delivery: WebhookDelivery) => Promise<void> | void;
  /** Fixed clock for deterministic timestamps. */
  readonly now?: () => Date;
  /** Numbers `listNumbers()` reports. */
  readonly numbers?: readonly PhoneNumber[];
  /** Whether `cancelCall` is supported, for capability-branch tests. */
  readonly cancel?: boolean;
}

interface CallState {
  ref: EngineCallRef;
  /** Our attempt id (metadata.call_id outbound; decision.attemptId inbound). */
  attemptId: string | null;
  locale: string;
  scenario: ScenarioName;
  status: EngineCallSnapshot['status'];
  answeredBy: EngineCallSnapshot['answeredBy'];
  endReason: EndReason | null;
  durationSec: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  cancelled: boolean;
  /** What a customer who says "yes" produces for this call's use case. */
  happy: Readonly<Record<string, unknown>>;
}

/**
 * The positive answer per use case, told apart by the variables the script receives: a cart
 * call carries `cart_summary`, a promotional call with an `order_ref` is post-delivery feedback
 * (ADR-0010); everything else is an order confirmation.
 */
function happyExtraction(req: PlaceCallRequest): Readonly<Record<string, unknown>> {
  if (req.variables['cart_summary'] !== undefined)
    return { outcome: 'will_complete', wants_link: true, confidence: 0.92 };
  if (req.metadata.purpose === 'promotional' && req.variables['order_ref'] !== undefined)
    return { outcome: 'feedback_given', nps: 9, comment: 'Arrived on time', confidence: 0.94 };
  return { outcome: 'confirmed', pincode_confirmed: true, confidence: 0.96 };
}

export class SimulatorAdapter implements VoiceEngineAdapter {
  readonly vendor = 'simulator';
  /** Webhooks emitted so far (when no sink is given). */
  readonly outbox: WebhookDelivery[] = [];

  private readonly calls = new Map<string, CallState>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly agents = new Map<string, AgentSpec>();
  private rateLimitHits = 0;
  private sequence = 0;

  constructor(private readonly options: SimulatorOptions) {}

  capabilities(): EngineCapabilities {
    return {
      inbound: true,
      cancel: this.options.cancel ?? true,
      warmTransfer: true,
      midCallTools: true,
      perSecondBilling: true,
      recordingToggle: false,
      signedWebhooks: true,
      reportsDisclosure: true,
    };
  }

  async createAgent(spec: AgentSpec): Promise<EngineAgentRef> {
    const agentId = `sim_agent_${sha256Hex(JSON.stringify(spec)).slice(0, 16)}`;
    this.agents.set(agentId, spec);
    return { vendor: this.vendor, agentId };
  }

  async updateAgent(ref: EngineAgentRef, spec: AgentSpec): Promise<void> {
    this.agents.set(ref.agentId, spec);
  }

  async placeCall(req: PlaceCallRequest): Promise<EngineCallRef> {
    // Rule 1. No exceptions, no flags, no "just this once".
    assertFakePhone(req.to);

    // Invariant 10 at the vendor: same key → same call, never a second dial.
    const existing = this.byIdempotencyKey.get(req.idempotencyKey);
    if (existing !== undefined) {
      const state = this.calls.get(existing);
      if (state !== undefined) return state.ref;
    }

    const scenario = this.scenarioFor(req);

    if (scenario === 'rate-limited') {
      this.rateLimitHits += 1;
      // First two calls are refused with a Retry-After; the third succeeds — a backoff test.
      if (this.rateLimitHits <= 2) throw new EngineRateLimited(this.vendor, 2);
    }
    if (scenario === 'engine-5xx')
      throw new EngineUnavailable(this.vendor, 'HTTP 503 from simulator');

    const ref: EngineCallRef = {
      vendor: this.vendor,
      callId: `sim_call_${randomBytes(8).toString('hex')}`,
    };
    const state: CallState = {
      ref,
      attemptId: req.metadata.call_id,
      locale: req.locale,
      scenario,
      status: 'queued',
      answeredBy: null,
      endReason: null,
      durationSec: null,
      startedAt: null,
      endedAt: null,
      cancelled: false,
      happy: happyExtraction(req),
    };
    this.calls.set(ref.callId, state);
    this.byIdempotencyKey.set(req.idempotencyKey, ref.callId);

    if (scenario === 'timeout-uncertain') {
      // The vendor accepted and will run the call, but our HTTP client never saw the 200.
      await this.runScenario(state, 'answered-human-confirmed');
      throw new EngineDispatchUncertain(this.vendor, req.idempotencyKey);
    }

    await this.runScenario(state, scenario);
    return ref;
  }

  async cancelCall(ref: EngineCallRef): Promise<void> {
    if (!this.capabilities().cancel)
      throw new EngineUnavailable(this.vendor, 'cancel not supported');
    const state = this.calls.get(ref.callId);
    if (state === undefined) return;
    if (state.status === 'queued' || state.status === 'ringing') {
      state.cancelled = true;
      state.status = 'ended';
      state.endReason = 'cancelled';
      state.endedAt = this.now();
      await this.emit(state, {
        type: 'call.ended',
        reason: 'cancelled',
        answeredBy: 'unknown',
        durationSec: 0,
      });
    }
  }

  parseWebhook(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): EngineEvent {
    const signature = headers['x-sim-signature'];
    const expected = createHmac('sha256', this.options.webhookSecret).update(rawBody).digest('hex');
    if (signature === undefined || !timingSafeEqualString(signature, expected)) {
      throw new SignatureInvalidError('simulator');
    }
    const payload = JSON.parse(rawBody.toString('utf8')) as WirePayload;
    return {
      ...payload.event,
      ref: { vendor: this.vendor, callId: payload.call_id },
      at: new Date(payload.at),
      attemptId: payload.attempt_id,
    } as EngineEvent;
  }

  async fetchCall(ref: EngineCallRef): Promise<EngineCallSnapshot> {
    const state = this.calls.get(ref.callId);
    if (state === undefined) {
      return {
        ref,
        status: 'not_found',
        answeredBy: null,
        durationSec: null,
        billableSec: null,
        endReason: null,
        startedAt: null,
        endedAt: null,
      };
    }
    return snapshot(state);
  }

  async findCallByIdempotencyKey(key: string): Promise<EngineCallSnapshot | null> {
    const callId = this.byIdempotencyKey.get(key);
    if (callId === undefined) return null;
    const state = this.calls.get(callId);
    return state === undefined ? null : snapshot(state);
  }

  async listNumbers(): Promise<readonly PhoneNumber[]> {
    return this.options.numbers ?? [];
  }

  async healthcheck(): Promise<HealthStatus> {
    return { healthy: true, detail: `simulator, ${String(this.calls.size)} calls` };
  }

  // ---- inbound + tools (ADR-0006) ------------------------------------------------------------

  parseInboundRequest(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): InboundCallRequest {
    this.verify(headers, rawBody);
    const body = JSON.parse(rawBody.toString('utf8')) as InboundWire;
    return {
      vendor: this.vendor,
      vendorCallId: body.call_id,
      calledE164: body.to,
      callerE164: body.from,
      at: new Date(body.at),
    };
  }

  formatInboundResponse(decision: InboundDecision): EngineHttpResponse {
    const body =
      decision.kind === 'answer'
        ? {
            action: 'answer',
            attempt_id: decision.attemptId,
            first_utterance: decision.firstUtterance,
            system_prompt: decision.systemPrompt,
            variables: decision.variables,
            tools: decision.tools,
            max_duration_sec: decision.maxDurationSec,
            locale: decision.locale,
            voice_id: decision.voiceId,
            webhook_url: decision.webhookUrl,
          }
        : decision.kind === 'forward'
          ? { action: 'forward', to: decision.toE164, announcement: decision.announcement }
          : { action: 'closed', message: decision.message, locale: decision.locale };
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  parseToolCall(
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Buffer,
  ): ToolCallRequest {
    this.verify(headers, rawBody);
    const body = JSON.parse(rawBody.toString('utf8')) as ToolWire;
    return {
      vendor: this.vendor,
      vendorCallId: body.call_id,
      toolCallId: body.tool_call_id,
      tool: body.tool,
      args: body.args,
      attemptId: body.attempt_id,
    };
  }

  formatToolResult(result: ToolResult): EngineHttpResponse {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    };
  }

  /**
   * Plays the vendor's side of an inbound call against OUR endpoints, exactly as a real
   * engine would: a signed context request, then one signed tool request per step (the tool
   * URL comes from our own decision), then the call events through the webhook sink. Steps
   * may compute their args from earlier results (the cancellation token, E-84).
   */
  async simulateInbound(
    convo: InboundConversation,
    transport: InboundTransport,
  ): Promise<InboundRun> {
    assertFakePhone(convo.calledE164);
    if (convo.callerE164 !== null) assertFakePhone(convo.callerE164);

    const callId = convo.vendorCallId ?? `sim_in_${randomBytes(8).toString('hex')}`;
    const contextBody: InboundWire = {
      call_id: callId,
      to: convo.calledE164,
      from: convo.callerE164,
      at: this.now().toISOString(),
    };
    const contextResponse = await transport.postInbound(
      this.signed(contextBody, convo.tamperContext === true),
    );
    const decision = contextResponse.status === 200 ? parseDecision(contextResponse.body) : null;
    const run: InboundRun = {
      callId,
      contextStatus: contextResponse.status,
      decision,
      toolResults: [],
      toolStatus: [],
    };
    if (decision?.kind !== 'answer') return run;

    const t0 = this.now();
    const state: CallState = {
      ref: { vendor: this.vendor, callId },
      attemptId: decision.attemptId,
      locale: decision.locale,
      scenario: 'answered-human-confirmed',
      status: 'in_progress',
      answeredBy: 'human',
      endReason: null,
      durationSec: null,
      startedAt: t0,
      endedAt: null,
      cancelled: false,
      happy: { outcome: 'resolved', confidence: 0.9 },
    };
    this.calls.set(callId, state);
    await this.emit(state, { type: 'call.answered', answeredBy: 'human' });
    await this.emit(state, {
      type: 'call.disclosed',
      aiDisclosedAt: new Date(t0.getTime() + 3_000).toISOString(),
      recordingDisclosedAt: new Date(t0.getTime() + 5_000).toISOString(),
    });

    let transferred = false;
    for (const [index, step] of convo.steps.entries()) {
      const tool = decision.tools.find((t) => t.name === step.tool);
      const args = typeof step.args === 'function' ? step.args(run.toolResults) : step.args;
      const toolBody: ToolWire = {
        call_id: callId,
        attempt_id: decision.attemptId,
        tool_call_id: `${callId}:tool:${String(index)}`,
        tool: step.tool,
        args,
      };
      const response = await transport.postTool(
        tool?.url ?? `/tools/simulator/unknown/${step.tool}`,
        this.signed(toolBody, step.tamper === true),
      );
      run.toolStatus.push(response.status);
      const result: ToolResult =
        response.status === 200
          ? (JSON.parse(response.body) as ToolResult)
          : { ok: false, data: { http_status: response.status }, say: null, action: null };
      run.toolResults.push(result);
      if (result.action?.kind === 'transfer') {
        transferred = true;
        await this.emit(state, {
          type: 'call.transferred',
          toMasked: maskForEvent(result.action.toE164),
          result: convo.transferResult ?? 'completed',
        });
        break;
      }
      if (result.action?.kind === 'end_call') break;
    }

    const reason: EndReason = transferred
      ? convo.transferResult === undefined || convo.transferResult === 'completed'
        ? 'transfer_completed'
        : 'transfer_failed'
      : convo.end.reason;
    state.status = 'ended';
    state.endReason = reason;
    state.durationSec = convo.end.durationSec;
    state.endedAt = new Date(t0.getTime() + convo.end.durationSec * 1000);
    await this.emit(state, {
      type: 'call.ended',
      reason,
      answeredBy: 'human',
      durationSec: convo.end.durationSec,
      billableSec: convo.end.durationSec,
      humanSpeechSec: convo.end.humanSpeechSec ?? Math.max(0, convo.end.durationSec - 10),
      recordingUrl: `https://simulator.invalid/recordings/${callId}.mp3`,
      transcript: [
        { role: 'agent', text: decision.firstUtterance, startMs: 0 },
        { role: 'customer', text: '[simulated caller]', startMs: 6_000 },
      ],
      extracted: convo.end.extracted ?? null,
      detectedLocale: decision.locale,
      vendorCost: { minor: Math.round(convo.end.durationSec * 6), currency: 'INR' },
    });
    return run;
  }

  private verify(headers: Readonly<Record<string, string | undefined>>, rawBody: Buffer): void {
    const signature = headers['x-sim-signature'];
    const expected = createHmac('sha256', this.options.webhookSecret).update(rawBody).digest('hex');
    if (signature === undefined || !timingSafeEqualString(signature, expected)) {
      throw new SignatureInvalidError('simulator');
    }
  }

  private signed(body: unknown, tamper: boolean): WebhookDelivery {
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const signature = tamper
      ? 'deadbeef'
      : createHmac('sha256', this.options.webhookSecret).update(rawBody).digest('hex');
    return {
      headers: { 'content-type': 'application/json', 'x-sim-signature': signature },
      rawBody,
    };
  }

  // ---- internals --------------------------------------------------------------------------

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private scenarioFor(req: PlaceCallRequest): ScenarioName {
    const explicit = req.variables['__scenario'];
    if (typeof explicit === 'string' && (SCENARIOS as readonly string[]).includes(explicit))
      return explicit as ScenarioName;
    return SCENARIO_BY_SUFFIX[req.to.slice(-3)] ?? 'answered-human-confirmed';
  }

  private async runScenario(state: CallState, scenario: ScenarioName): Promise<void> {
    const t0 = this.now();
    const ring = async () => {
      state.status = 'ringing';
      await this.emit(state, { type: 'call.ringing' });
    };
    const answer = async (by: 'human' | 'machine') => {
      state.status = 'in_progress';
      state.answeredBy = by;
      state.startedAt = t0;
      await this.emit(state, { type: 'call.answered', answeredBy: by });
      if (by === 'human') {
        await this.emit(state, {
          type: 'call.disclosed',
          aiDisclosedAt: new Date(t0.getTime() + 2_000).toISOString(),
          recordingDisclosedAt: new Date(t0.getTime() + 4_000).toISOString(),
        });
      }
    };
    const end = async (reason: EndReason, durationSec: number, extra: Partial<EndedWire> = {}) => {
      state.status = reason === 'invalid_number' || reason === 'engine_error' ? 'failed' : 'ended';
      state.endReason = reason;
      state.durationSec = durationSec;
      state.endedAt = new Date(t0.getTime() + durationSec * 1000);
      await this.emit(state, {
        type: 'call.ended',
        reason,
        answeredBy: state.answeredBy ?? 'unknown',
        durationSec,
        billableSec: durationSec,
        humanSpeechSec: state.answeredBy === 'human' ? Math.max(0, durationSec - 8) : 0,
        recordingUrl:
          state.answeredBy === null
            ? null
            : `https://simulator.invalid/recordings/${state.ref.callId}.mp3`,
        transcript: null,
        extracted: null,
        detectedLocale: state.locale,
        vendorCost: { minor: Math.round(durationSec * 6), currency: 'INR' }, // ₹3.60/min
        ...extra,
      });
    };
    const confirmedTranscript = [
      {
        role: 'agent',
        text: 'Namaste, main automated AI assistant bol rahi hoon, yeh call record ho rahi hai.',
        startMs: 0,
      },
      { role: 'customer', text: 'Haan, bolo.', startMs: 6_000 },
      { role: 'agent', text: 'Aapka order confirm karein?', startMs: 8_000 },
      { role: 'customer', text: 'Haan, confirm hai.', startMs: 12_000 },
    ] as const;

    switch (scenario) {
      case 'answered-human-confirmed':
      case 'timeout-uncertain':
        await ring();
        await answer('human');
        await end('completed', 45, {
          transcript: [...confirmedTranscript],
          extracted: { ...state.happy },
        });
        return;
      case 'answered-human-cancelled':
        await ring();
        await answer('human');
        await end('completed', 38, {
          extracted: { outcome: 'cancelled', cancel_reason: 'changed_mind', confidence: 0.93 },
        });
        return;
      case 'answered-machine':
        await ring();
        await answer('machine');
        await end('amd_hangup', 6);
        return;
      case 'no-answer':
        await ring();
        await end('no_answer', 0);
        return;
      case 'busy':
        await end('busy', 0);
        return;
      case 'transfer-success':
        await ring();
        await answer('human');
        await this.emit(state, {
          type: 'call.transferred',
          toMasked: '+91 60xxx xx101',
          result: 'completed',
        });
        await end('transfer_completed', 90, {
          extracted: { outcome: 'transferred', confidence: 0.99 },
        });
        return;
      case 'transfer-fail':
        await ring();
        await answer('human');
        await this.emit(state, {
          type: 'call.transferred',
          toMasked: '+91 60xxx xx101',
          result: 'no_answer',
        });
        await end('transfer_failed', 70, {
          extracted: { outcome: 'callback_requested', confidence: 0.9 },
        });
        return;
      case 'opt-out-mid-call':
        await ring();
        await answer('human');
        await end('opt_out', 14, { extracted: { outcome: 'opt_out', confidence: 0.99 } });
        return;
      case 'wrong-number':
        await ring();
        await answer('human');
        await end('wrong_number', 12, { extracted: { outcome: 'wrong_number', confidence: 0.95 } });
        return;
      case 'minor-answered':
        await ring();
        await answer('human');
        await end('minor_answered', 9, {
          extracted: { outcome: 'minor_answered', confidence: 0.9 },
        });
        return;
      case 'pocket-answer':
        await ring();
        await answer('human');
        await end('customer_hangup', 11, {
          humanSpeechSec: 0,
          extracted: { outcome: 'inconclusive', confidence: 0.4 },
        });
        return;
      case 'webhook-duplicate':
        await ring();
        await answer('human');
        await end('completed', 40, { extracted: { outcome: 'confirmed', confidence: 0.95 } });
        // The vendor retried: same event id, same body, delivered twice.
        await this.redeliverLast();
        return;
      case 'webhook-out-of-order':
        // ended arrives before answered/ringing.
        state.answeredBy = 'human';
        state.startedAt = t0;
        await end('completed', 33, { extracted: { outcome: 'confirmed', confidence: 0.9 } });
        await this.emit(state, { type: 'call.ringing' });
        await this.emit(state, { type: 'call.answered', answeredBy: 'human' });
        return;
      case 'webhook-missing':
        await ring();
        await answer('human');
        // The call ends but no webhook ever arrives; fetchCall() knows the truth (E-21).
        state.status = 'ended';
        state.endReason = 'completed';
        state.durationSec = 42;
        state.endedAt = new Date(t0.getTime() + 42_000);
        return;
      case 'unsigned-webhook':
        await ring();
        await answer('human');
        await end('completed', 36, { extracted: { outcome: 'confirmed', confidence: 0.95 } });
        // Vendor "forgot" to sign the final event: re-deliver it with a bad signature.
        await this.redeliverLast({ 'x-sim-signature': 'deadbeef' });
        return;
      case 'invalid-number':
        await end('invalid_number', 0);
        return;
      case 'rate-limited':
      case 'engine-5xx':
        // Reached only after the throws above have been exhausted (rate-limited 3rd try).
        await ring();
        await answer('human');
        await end('completed', 30, { extracted: { outcome: 'confirmed', confidence: 0.9 } });
        return;
    }
  }

  private async emit(state: CallState, event: WireEvent): Promise<void> {
    this.sequence += 1;
    const payload: WirePayload = {
      call_id: state.ref.callId,
      attempt_id: state.attemptId,
      at: this.now().toISOString(),
      event: {
        ...event,
        eventId: `${state.ref.callId}:${String(this.sequence)}`,
        sequence: this.sequence,
      },
    };
    await this.deliver(payload);
  }

  private lastPayload: WirePayload | null = null;

  private async deliver(
    payload: WirePayload,
    headerOverride: Record<string, string> = {},
  ): Promise<void> {
    this.lastPayload = payload;
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = createHmac('sha256', this.options.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const delivery: WebhookDelivery = {
      headers: {
        'content-type': 'application/json',
        'x-sim-signature': signature,
        'x-sim-event-id': payload.event.eventId,
        ...headerOverride,
      },
      rawBody,
    };
    if (this.options.sink !== undefined) await this.options.sink(delivery);
    else this.outbox.push(delivery);
  }

  private async redeliverLast(headerOverride: Record<string, string> = {}): Promise<void> {
    if (this.lastPayload !== null) await this.deliver(this.lastPayload, headerOverride);
  }
}

// ---- inbound driver types ------------------------------------------------------------------

export interface InboundTransport {
  /** Deliver the signed context request to our inbound endpoint and return its response. */
  postInbound(delivery: WebhookDelivery): Promise<EngineHttpResponse>;
  /** Deliver a signed tool request to the URL our decision gave for that tool. */
  postTool(url: string, delivery: WebhookDelivery): Promise<EngineHttpResponse>;
}

export interface InboundStep {
  readonly tool: string;
  readonly args:
    | Readonly<Record<string, unknown>>
    | ((previous: readonly ToolResult[]) => Readonly<Record<string, unknown>>);
  /** Send this tool call with a bad signature. */
  readonly tamper?: boolean;
}

export interface InboundConversation {
  readonly calledE164: string;
  /** Null = withheld caller ID (E-80). */
  readonly callerE164: string | null;
  readonly steps: readonly InboundStep[];
  readonly end: {
    readonly reason: EndReason;
    readonly durationSec: number;
    readonly extracted?: Readonly<Record<string, unknown>> | null;
    readonly humanSpeechSec?: number | null;
  };
  /** Reuse a call id (engine retrying the context webhook, E-89). */
  readonly vendorCallId?: string;
  readonly tamperContext?: boolean;
  readonly transferResult?: 'completed' | 'no_answer' | 'busy' | 'failed';
}

export interface InboundRun {
  readonly callId: string;
  readonly contextStatus: number;
  readonly decision: InboundDecision | null;
  readonly toolResults: ToolResult[];
  readonly toolStatus: number[];
}

interface InboundWire {
  call_id: string;
  to: string;
  from: string | null;
  at: string;
}

interface ToolWire {
  call_id: string;
  attempt_id: string | null;
  tool_call_id: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
}

function parseDecision(body: string): InboundDecision {
  const b = JSON.parse(body) as Record<string, unknown>;
  switch (b['action']) {
    case 'answer':
      return {
        kind: 'answer',
        attemptId: String(b['attempt_id']),
        firstUtterance: String(b['first_utterance']),
        systemPrompt: String(b['system_prompt']),
        variables: b['variables'] as Record<string, string>,
        tools: b['tools'] as readonly ToolDefinition[],
        maxDurationSec: Number(b['max_duration_sec']),
        locale: b['locale'] as Locale,
        voiceId: (b['voice_id'] as string | null) ?? null,
        webhookUrl: String(b['webhook_url']),
      };
    case 'forward':
      return {
        kind: 'forward',
        toE164: String(b['to']),
        announcement: (b['announcement'] as string | null) ?? null,
      };
    default:
      return { kind: 'closed', message: String(b['message']), locale: b['locale'] as Locale };
  }
}

function maskForEvent(e164: string): string {
  return `${e164.slice(0, 3)} ${e164.slice(3, 5)}xxx xx${e164.slice(-3)}`;
}

// Wire format: what the simulator "POSTs". Dates are ISO strings on the wire.
interface EndedWire {
  type: 'call.ended';
  reason: EndReason;
  answeredBy: 'human' | 'machine' | 'unknown';
  durationSec: number;
  billableSec: number | null;
  humanSpeechSec: number | null;
  recordingUrl: string | null;
  transcript: readonly { role: 'agent' | 'customer'; text: string; startMs: number }[] | null;
  extracted: Readonly<Record<string, unknown>> | null;
  detectedLocale: string | null;
  vendorCost: { minor: number; currency: string } | null;
}

type WireEvent =
  | { type: 'call.ringing' }
  | { type: 'call.answered'; answeredBy: 'human' | 'machine' }
  | { type: 'call.disclosed'; aiDisclosedAt: string; recordingDisclosedAt: string }
  | {
      type: 'call.transferred';
      toMasked: string;
      result: 'completed' | 'no_answer' | 'busy' | 'failed';
    }
  | ({
      type: 'call.ended';
      reason: EndReason;
      answeredBy: 'human' | 'machine' | 'unknown';
      durationSec: number;
    } & Partial<EndedWire>)
  | { type: 'call.failed'; code: string; message: string; retryable: boolean };

interface WirePayload {
  call_id: string;
  attempt_id: string | null;
  at: string;
  event: WireEvent & { eventId: string; sequence: number };
}

function snapshot(state: CallState): EngineCallSnapshot {
  return {
    ref: state.ref,
    status: state.status,
    answeredBy: state.answeredBy,
    durationSec: state.durationSec,
    billableSec: state.durationSec,
    endReason: state.endReason,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
  };
}
