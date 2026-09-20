import type { OmniCallLog, OmniWebhook } from '../src/wire.js';

/**
 * A stand-in for OmniDimension's API and post-call webhook, shaped from the published API
 * reference (P1-ENG-3). NOT a recording: go-live 03 replaces these payloads with sanitised real
 * ones. One webhook per call, unsigned, after the call is over.
 */

export interface Delivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Buffer;
}

export interface FakeOmnidim {
  readonly fetchImpl: typeof fetch;
  readonly outbox: Delivery[];
  readonly logs: OmniCallLog[];
  readonly requests: { method: string; path: string; body: unknown }[];
}

interface Shape {
  readonly status: string;
  readonly sec: number;
  readonly voicemail?: boolean;
  readonly outcome?: string;
}

const SHAPES: Record<string, Shape> = {
  'answered-machine': { status: 'completed', sec: 8, voicemail: true },
  'no-answer': { status: 'no-answer', sec: 0 },
  busy: { status: 'busy', sec: 0 },
  'opt-out-mid-call': { status: 'completed', sec: 12, outcome: 'opt_out' },
};
const HAPPY: Shape = { status: 'completed', sec: 45, outcome: 'confirmed' };

export const FROM_NUMBER_ID = 23;

export function fakeOmnidim(fromE164: string): FakeOmnidim {
  const outbox: Delivery[] = [];
  const logs: OmniCallLog[] = [];
  const requests: FakeOmnidim['requests'] = [];
  let rateLimitHits = 0;
  let seq = 3_166_900;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname.replace(/^\/api\/v1/, '');
    requests.push({ method, path, body });

    if (method === 'POST' && path === '/agents/create')
      return json(200, { id: 158_910, name: body['name'], status: 'Completed' });
    if (method === 'PUT' && path.startsWith('/agents/')) return json(200, { success: true });
    if (method === 'GET' && path === '/phone_number/list')
      return json(200, {
        success: true,
        phone_numbers: [{ id: FROM_NUMBER_ID, phone_number: fromE164 }],
      });

    if (method === 'POST' && path === '/calls/dispatch') {
      const given = (body['call_context'] as Record<string, unknown> | undefined)?.['__scenario'];
      const scenario = typeof given === 'string' ? given : '';
      if (scenario === 'rate-limited' && ++rateLimitHits <= 2)
        return json(429, { error: 'rate_limited' }, { 'retry-after': '2' });
      if (scenario === 'engine-5xx') return json(503, { error: 'unavailable' });
      seq += 1;
      const requestId = seq;
      const shape = SHAPES[scenario] ?? HAPPY;
      const connected = shape.status === 'completed' && shape.sec > 0;
      const conversation =
        connected && shape.voicemail !== true
          ? ' <br/> LLM: Namaste, main ek automated AI assistant hoon, yeh call record ho rahi hai. <br/> user: Haan, bhej dijiye. <br/>'
          : '';
      const extracted =
        shape.outcome === undefined
          ? {}
          : { outcome: shape.outcome, confidence__f: '0.95', note: 'Not provided' };
      const log: OmniCallLog = {
        id: requestId - 3_000_000,
        to_number: String(body['to_number']),
        from_number: fromE164,
        call_direction: 'outbound',
        call_status: shape.status,
        call_duration_in_seconds: shape.sec,
        recording_url: connected ? `https://omnidim.test/rec/${String(requestId)}.mp3` : false,
        call_conversation: conversation === '' ? false : conversation,
        extracted_variables: extracted,
        is_voicemail: shape.voicemail === true,
        amd_detected: shape.voicemail === true,
        hangup_source: false,
        hangup_reason: null,
        call_cost: connected ? 0.12 : 0,
        call_request_id: { id: requestId },
        time_of_call: '09/14/2026 10:30:00',
      };
      const webhook: OmniWebhook = {
        call_id: log.id,
        call_request_id: requestId,
        call_direction: 'outbound',
        call_status: shape.status,
        call_duration: shape.sec,
        start_time: '2026-09-14 10:30:00',
        end_time: '2026-09-14 10:31:00',
        hangup_source: false,
        recording_url: log.recording_url ?? false,
        is_voicemail: shape.voicemail === true,
        call_report: {
          extracted_variables: extracted,
          full_conversation: conversation.replace(/<br\/>/g, '\n'),
        },
        metadata: (body['metadata'] as Record<string, unknown> | undefined) ?? null,
      };
      const deliver = () => {
        outbox.push({
          rawBody: Buffer.from(JSON.stringify(webhook), 'utf8'),
          headers: { 'content-type': 'application/json' },
        });
      };
      logs.unshift(log);
      if (scenario !== 'webhook-missing') deliver();
      if (scenario === 'webhook-duplicate') deliver();
      if (scenario === 'timeout-uncertain')
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        });
      return json(200, { success: true, status: 'dispatched', requestId });
    }
    if (method === 'GET' && path === '/calls/logs')
      // The list is a trimmed projection: no transcript, no variables.
      return json(200, {
        call_log_data: logs.map((l) => ({
          id: l.id,
          call_status: l.call_status,
          call_request_id: l.call_request_id,
        })),
        total_records: logs.length,
      });
    if (method === 'GET' && path.startsWith('/calls/logs/')) {
      const hit = logs.find((l) => String(l.id) === path.slice('/calls/logs/'.length));
      return hit === undefined
        ? json(404, { error: 'not_found' })
        : json(200, { call_log_data: [hit], total_records: 1 });
    }
    return json(404, { error: `no route ${method} ${path}` });
  };

  return { fetchImpl, outbox, logs, requests };
}
