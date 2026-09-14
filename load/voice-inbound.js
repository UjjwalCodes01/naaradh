import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { baseUrl, fakePhone, hmacHex, required, summary } from './lib.js';

/**
 * 100 inbound-context requests in 10 seconds, each followed by one mid-call tool call (AGENTS
 * §12: "100 inbound context requests/10 s with tool calls at p95 < 700 ms"). Plays the engine's
 * side exactly as the simulator adapter does: a signed context POST to /inbound/simulator, then
 * a signed tool POST to the tool URL the decision handed back.
 *
 *   k6 run -e VOICE_URL=https://voice.stage.naaradh.com \
 *          -e SIMULATOR_WEBHOOK_SECRET=<staging's SIMULATOR_WEBHOOK_SECRET> \
 *          -e CALLED_NUMBER=<a support line registered to a staging tenant, inbound enabled> \
 *          load/voice-inbound.js
 *
 * Budgets (ADR-0006, E-93): inbound context p95 < 500 ms; tool call p95 < 700 ms. The caller is
 * always in the fake range, so identity resolves to `none` or to whatever fake orders staging
 * holds; `lookup_order` is a safe tool for an unverified caller (it answers with a verification
 * request, never data).
 */

const VOICE = baseUrl('VOICE_URL');
const SECRET = required('SIMULATOR_WEBHOOK_SECRET');
const CALLED = required('CALLED_NUMBER');
const inboundMs = new Trend('inbound_context_ms', true);
const toolMs = new Trend('tool_call_ms', true);

export const options = {
  scenarios: {
    calls: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '10s',
      duration: '10s',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
  },
  thresholds: {
    inbound_context_ms: ['p(95)<500'],
    tool_call_ms: ['p(95)<700'],
    http_req_failed: ['rate<0.01'],
  },
};

function signed(url, payload, name) {
  const body = JSON.stringify(payload);
  return http.post(url, body, {
    headers: { 'Content-Type': 'application/json', 'x-sim-signature': hmacHex(SECRET, body) },
    tags: { name },
  });
}

export default function () {
  const n = __VU * 100000 + __ITER;
  const callId = `sim_load_${Date.now().toString(36)}_${n}`;
  const context = signed(
    `${VOICE}/inbound/simulator`,
    { call_id: callId, to: CALLED, from: fakePhone(n), at: new Date().toISOString() },
    'inbound_context',
  );
  inboundMs.add(context.timings.duration);
  const decision = context.status === 200 ? context.json() : null;
  check(context, {
    'context 200': (r) => r.status === 200,
    'decision is answer/forward/closed': () =>
      decision !== null && ['answer', 'forward', 'closed'].includes(decision.action),
  });
  if (decision === null || decision.action !== 'answer') return;

  const tool = (decision.tools || []).find((t) => t.name === 'lookup_order') || decision.tools[0];
  if (!tool) return;
  const res = signed(
    tool.url,
    {
      call_id: callId,
      attempt_id: decision.attempt_id,
      tool_call_id: `tc_${n}`,
      tool: tool.name,
      args: tool.name === 'lookup_order' ? {} : {},
    },
    'tool_call',
  );
  toolMs.add(res.timings.duration);
  check(res, { 'tool 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return summary(data, 'load/results/voice-inbound.json');
}
