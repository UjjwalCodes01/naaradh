import { signRetell } from '../src/signature.js';
import type { RetellCall, RetellWebhook } from '../src/wire.js';

/**
 * A stand-in for Retell's API and webhooks, shaped from the published API reference (P6-ENG-1).
 * It is NOT a recording: `docs/go-live/10-us-eu.md` replaces the payloads below with sanitised
 * ones captured on the first live call, and every [VERIFY] in the adapter is settled then.
 *
 * `placeCall` for a contract scenario (the harness passes it as the `__scenario` variable)
 * queues the webhooks Retell would send, signed with the account key, into `outbox`.
 */

export interface Delivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Buffer;
}

const T0 = Date.parse('2026-09-14T16:00:00Z');

/** A realistic human turn: the customer speaks for a few seconds (E-25). */
const HUMAN_TRANSCRIPT = [
  {
    role: 'agent',
    content: 'Hi, this is an automated AI assistant, and this call is recorded.',
    words: [{ word: 'Hi', start: 0.4, end: 0.6 }],
  },
  {
    role: 'user',
    content: 'Yes, go ahead and ship it please.',
    words: [
      { word: 'Yes', start: 6.1, end: 6.5 },
      { word: 'go', start: 6.6, end: 9.4 },
      { word: 'please', start: 9.5, end: 12.4 },
    ],
  },
];

export interface FakeRetell {
  readonly fetchImpl: typeof fetch;
  readonly outbox: Delivery[];
  readonly calls: Map<string, RetellCall>;
  readonly requests: { method: string; path: string; body: unknown }[];
}

export function fakeRetell(apiKey: string, now: () => Date): FakeRetell {
  const outbox: Delivery[] = [];
  const calls = new Map<string, RetellCall>();
  const requests: FakeRetell['requests'] = [];
  let rateLimitHits = 0;
  let seq = 0;

  const deliver = (event: RetellWebhook['event'], call: RetellCall, key = apiKey) => {
    const rawBody = Buffer.from(JSON.stringify({ event, call }), 'utf8');
    outbox.push({
      rawBody,
      headers: {
        'content-type': 'application/json',
        'x-retell-signature': signRetell(key, rawBody, now().getTime()),
      },
    });
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  function callFor(
    id: string,
    req: Record<string, unknown>,
    shape: {
      reason: string;
      durationMs: number;
      connected: boolean;
      voicemail?: boolean;
      outcome?: string;
    },
  ): RetellCall {
    return {
      call_id: id,
      agent_id: typeof req['override_agent_id'] === 'string' ? req['override_agent_id'] : '',
      call_status: shape.connected ? 'ended' : 'not_connected',
      direction: 'outbound',
      from_number: String(req['from_number']),
      to_number: String(req['to_number']),
      metadata: (req['metadata'] as Record<string, unknown> | undefined) ?? null,
      start_timestamp: shape.connected ? T0 : null,
      end_timestamp: T0 + shape.durationMs,
      duration_ms: shape.durationMs,
      transcript_object: shape.connected && shape.voicemail !== true ? HUMAN_TRANSCRIPT : [],
      recording_url: shape.connected ? `https://retell.test/recordings/${id}.wav` : null,
      disconnection_reason: shape.reason,
      call_analysis: {
        in_voicemail: shape.voicemail === true,
        custom_analysis_data:
          shape.outcome === undefined ? null : { outcome: shape.outcome, confidence: 0.95 },
      },
      call_cost: { combined_cost: 14, total_duration_seconds: Math.ceil(shape.durationMs / 1000) },
    };
  }

  /** Webhooks for one scenario, in the order Retell would send them. */
  function script(scenario: string, full: RetellCall) {
    const started: RetellCall = { ...full, call_status: 'ongoing', end_timestamp: null };
    const ended: RetellCall = { ...full, call_analysis: null };
    switch (scenario) {
      case 'no-answer':
      case 'busy':
        deliver('call_ended', ended);
        deliver('call_analyzed', full);
        return;
      case 'webhook-duplicate': {
        deliver('call_started', started);
        deliver('call_ended', ended);
        deliver('call_analyzed', full);
        const last = outbox[outbox.length - 1];
        if (last !== undefined) outbox.push(last);
        return;
      }
      case 'webhook-out-of-order':
        deliver('call_analyzed', full);
        deliver('call_started', started);
        deliver('call_ended', ended);
        return;
      case 'webhook-missing':
        deliver('call_started', started);
        return;
      case 'unsigned-webhook':
        deliver('call_started', started);
        deliver('call_ended', ended, 'not-the-account-key');
        deliver('call_analyzed', full);
        return;
      default:
        deliver('call_started', started);
        deliver('call_ended', ended);
        deliver('call_analyzed', full);
    }
  }

  const SHAPES: Record<string, Parameters<typeof callFor>[2]> = {
    'answered-machine': {
      reason: 'voicemail_reached',
      durationMs: 8_000,
      connected: true,
      voicemail: true,
      outcome: 'no_response',
    },
    'no-answer': { reason: 'dial_no_answer', durationMs: 0, connected: false },
    busy: { reason: 'dial_busy', durationMs: 0, connected: false },
    'opt-out-mid-call': {
      reason: 'agent_hangup',
      durationMs: 12_000,
      connected: true,
      outcome: 'opt_out',
    },
  };
  const HAPPY = {
    reason: 'agent_hangup',
    durationMs: 45_000,
    connected: true,
    outcome: 'confirmed',
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ method, path: url.pathname, body });
    const path = url.pathname;

    if (method === 'POST' && path === '/create-retell-llm')
      return json(201, { llm_id: 'llm_test_1' });
    if (method === 'POST' && path === '/create-agent')
      return json(201, { agent_id: 'agent_test_1' });
    if (method === 'GET' && path.startsWith('/get-agent/'))
      return json(200, { response_engine: { type: 'retell-llm', llm_id: 'llm_test_1' } });
    if (method === 'PATCH') return json(200, {});
    if (method === 'GET' && path === '/list-phone-numbers') return json(200, []);

    if (method === 'POST' && path === '/v2/create-phone-call') {
      const scenario = String(
        (body['retell_llm_dynamic_variables'] as Record<string, string> | undefined)?.[
          '__scenario'
        ] ?? '',
      );
      if (scenario === 'rate-limited' && ++rateLimitHits <= 2)
        return json(429, { error: 'too many' }, { 'retry-after': '2' });
      if (scenario === 'engine-5xx') return json(503, { error: 'unavailable' });
      seq += 1;
      const id = `call_${String(seq).padStart(6, '0')}`;
      const full = callFor(id, body, SHAPES[scenario] ?? HAPPY);
      calls.set(id, full);
      script(scenario, full);
      if (scenario === 'timeout-uncertain')
        // Retell took the call, but the response never reaches us before our timeout.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        });
      return json(201, { ...full, call_status: 'registered' });
    }
    if (method === 'GET' && path.startsWith('/v2/get-call/')) {
      const call = calls.get(decodeURIComponent(path.slice('/v2/get-call/'.length)));
      return call === undefined ? json(404, { error: 'not found' }) : json(200, call);
    }
    if (method === 'POST' && path === '/v2/list-calls')
      return json(200, [...calls.values()].reverse());
    return json(404, { error: `no route ${method} ${path}` });
  };

  return { fetchImpl, outbox, calls, requests };
}
