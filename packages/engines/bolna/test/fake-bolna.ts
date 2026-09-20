import type { BolnaExecution } from '../src/wire.js';

/**
 * A stand-in for Bolna's API and webhooks, shaped from the published API reference (P1-ENG-3).
 * It is NOT a recording: go-live 03 replaces the payloads below with sanitised ones captured on
 * the first test calls, and every [VERIFY] in the adapter is settled then.
 *
 * `POST /call` for a contract scenario (the harness passes it as the `__scenario` variable)
 * queues the webhooks Bolna would send — one per status change, unsigned — into `outbox`.
 */

export interface Delivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Buffer;
}

export interface FakeBolna {
  readonly fetchImpl: typeof fetch;
  readonly outbox: Delivery[];
  readonly executions: Map<string, BolnaExecution>;
  readonly requests: { method: string; path: string; body: unknown; auth: string | null }[];
}

interface Shape {
  readonly status: string;
  readonly talkSec: number;
  readonly voicemail?: boolean;
  readonly outcome?: string;
  readonly hangupBy?: string;
}

const SHAPES: Record<string, Shape> = {
  'answered-machine': { status: 'completed', talkSec: 8, voicemail: true },
  'no-answer': { status: 'no-answer', talkSec: 0 },
  busy: { status: 'busy', talkSec: 0 },
  'opt-out-mid-call': { status: 'completed', talkSec: 12, outcome: 'opt_out' },
};
const HAPPY: Shape = { status: 'completed', talkSec: 45, outcome: 'confirmed' };

export function fakeBolna(): FakeBolna {
  const outbox: Delivery[] = [];
  const executions = new Map<string, BolnaExecution>();
  const requests: FakeBolna['requests'] = [];
  let rateLimitHits = 0;
  let seq = 0;

  const deliver = (x: BolnaExecution) => {
    outbox.push({
      rawBody: Buffer.from(JSON.stringify(x), 'utf8'),
      headers: { 'content-type': 'application/json' },
    });
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  function executionFor(id: string, req: Record<string, unknown>, shape: Shape): BolnaExecution {
    const connected = shape.status === 'completed' && shape.talkSec > 0;
    return {
      id,
      agent_id: String(req['agent_id']),
      status: shape.status,
      error_message: null,
      conversation_duration: shape.talkSec,
      answered_by_voice_mail: shape.voicemail === true ? true : null,
      created_at: '2026-09-14T10:30:00.408883+00:00',
      initiated_at: '2026-09-14T10:30:02.737874',
      updated_at: '2026-09-14T10:31:10.320486+00:00',
      transcript:
        connected && shape.voicemail !== true
          ? 'assistant: Namaste, main ek automated AI assistant hoon, yeh call record ho rahi hai.\nuser: Haan, order bhej dijiye.\n'
          : connected
            ? 'assistant: Namaste, main ek automated AI assistant hoon.\n'
            : '',
      extracted_data:
        shape.outcome === undefined
          ? {}
          : {
              Naaradh: {
                outcome: { objective: shape.outcome, subjective: null, confidence: 0.9 },
                confidence__f: { objective: null, subjective: '0.95', confidence: 0.8 },
              },
            },
      telephony_data: {
        duration: shape.talkSec === 0 ? 0 : shape.talkSec + 6,
        to_number: String(req['recipient_phone_number']),
        from_number: String(req['from_phone_number']),
        recording_url: connected ? `https://api.bolna.test/recordings/call/${id}` : null,
        call_type: 'outbound',
        provider: 'plivo',
        hangup_by: shape.hangupBy ?? 'Plivo',
        hangup_reason: 'Normal Hangup',
        hangup_provider_code: 4000,
      },
      total_cost: connected ? 3 : 0,
      cost_breakdown: { total_cost_to_deduct: connected ? 1.878 : 0 },
      context_details: {
        recipient_data: (req['user_data'] as Record<string, unknown> | undefined) ?? null,
      },
      transfer_call_data: null,
    };
  }

  /** Webhooks for one scenario, in the order Bolna would send them. */
  function script(scenario: string, full: BolnaExecution) {
    const blank = {
      conversation_duration: 0,
      transcript: '',
      extracted_data: {},
      total_cost: 0,
      answered_by_voice_mail: null,
    };
    const at = (status: string): BolnaExecution => ({ ...full, ...blank, status });
    const answered: BolnaExecution = {
      ...at('in-progress'),
      answered_by_voice_mail: full.answered_by_voice_mail ?? null,
    };
    switch (scenario) {
      case 'no-answer':
      case 'busy':
        deliver(at('queued'));
        deliver(at('initiated'));
        deliver(at('ringing'));
        deliver(full);
        return;
      case 'webhook-duplicate':
        deliver(at('ringing'));
        deliver(answered);
        deliver(at('call-disconnected'));
        deliver(full);
        deliver(full);
        return;
      case 'webhook-out-of-order':
        deliver(full);
        deliver(at('ringing'));
        deliver(answered);
        return;
      case 'webhook-missing':
        deliver(at('ringing'));
        deliver(answered);
        return;
      default:
        deliver(at('queued'));
        deliver(at('initiated'));
        deliver(at('ringing'));
        deliver(answered);
        deliver(at('call-disconnected'));
        deliver(full);
    }
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method, path: url.pathname, body, auth: headers['authorization'] ?? null });
    const path = url.pathname;

    if (method === 'POST' && path === '/v2/agent')
      return json(201, { agent_id: 'agent-0001', state: 'created' });
    if (method === 'PUT' && path.startsWith('/v2/agent/')) return json(200, { state: 'updated' });
    if (method === 'POST' && path === '/dispositions/bulk') return json(201, { ids: ['d1'] });
    if (method === 'POST' && path === '/inbound/setup') return json(200, { message: 'done' });
    if (method === 'GET' && path === '/phone-numbers/all')
      return json(200, [
        { id: 'pn-0001', phone_number: '+916000000100', telephony_provider: 'plivo' },
      ]);
    if (method === 'GET' && path === '/v2/agent/all') return json(200, [{ id: 'agent-0001' }]);
    if (method === 'GET' && /^\/v2\/agent\/[^/]+\/executions$/.test(path))
      return json(200, {
        data: [...executions.values()]
          .reverse()
          .map((x) => ({ id: x.id, status: x.status, created_at: x.created_at })),
      });

    if (method === 'POST' && path === '/call') {
      const given = (body['user_data'] as Record<string, unknown> | undefined)?.['__scenario'];
      const scenario = typeof given === 'string' ? given : '';
      if (scenario === 'rate-limited' && ++rateLimitHits <= 2)
        return json(429, { message: 'too many' }, { 'retry-after': '2' });
      if (scenario === 'engine-5xx') return json(503, { message: 'unavailable' });
      seq += 1;
      const id = `b7140255-af33-4608-8e97-${String(seq).padStart(12, '0')}`;
      const full = executionFor(id, body, SHAPES[scenario] ?? HAPPY);
      executions.set(id, full);
      script(scenario, full);
      if (scenario === 'timeout-uncertain')
        // Bolna queued the call, but the response never reaches us before our timeout.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        });
      return json(200, { message: 'done', status: 'queued', execution_id: id });
    }
    if (method === 'POST' && /^\/call\/[^/]+\/stop$/.test(path))
      return json(200, { message: 'done', status: 'stopped' });
    if (method === 'GET' && path.startsWith('/executions/')) {
      const x = executions.get(decodeURIComponent(path.slice('/executions/'.length)));
      return x === undefined ? json(404, { message: 'not found' }) : json(200, x);
    }
    return json(404, { message: `no route ${method} ${path}` });
  };

  return { fetchImpl, outbox, executions, requests };
}
