import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, fakePhone, required, summary } from './lib.js';

/**
 * 50 concurrent lead-callback intents through the public API → 50 simulated calls in flight at
 * once on staging (SPEC §14 "50 concurrent calls in staging with engine simulator").
 *
 *   k6 run -e API_URL=https://api.stage.naaradh.com \
 *          -e API_KEY=nrd_test_… (a secret key of a staging tenant with lead_callback enabled) \
 *          load/api-intents.js
 *
 * Run inside 09:00–21:00 IST: outside the window the gate defers every intent (invariant 3)
 * and the dispatcher never dials, which measures the API but not the call path. Each intent
 * has a unique external_ref (otherwise the API answers `duplicate`, by design) and a distinct
 * fake number (otherwise E-42 merges them into one call, also by design). Watch the dispatcher
 * and the engine concurrency counter (ENGINE_MAX_CONCURRENCY) on the staging dashboards while
 * it runs; the API-side thresholds below only cover the request.
 */

const API = baseUrl('API_URL');
const KEY = required('API_KEY');
const RUN = Date.now().toString(36);

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const n = __VU;
  const body = JSON.stringify({
    use_case: 'lead_callback',
    phone: fakePhone(n),
    name: `Load Test ${n}`,
    external_ref: `load-${RUN}-${n}`,
    event_ts: new Date().toISOString(),
    variables: { source: 'k6' },
    consent: { purpose: 'service', source: 'form', wording_version: 'load-test' },
  });
  const res = http.post(`${API}/v1/intents`, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      'Idempotency-Key': `load-${RUN}-${n}`,
    },
    tags: { name: 'create_intent' },
  });
  const status = res.status === 202 || res.status === 200 ? res.json('status') : null;
  check(res, {
    accepted: (r) => r.status === 202,
    'scheduled (inside the window, not gated)': () => status === 'scheduled',
  });
}

export function handleSummary(data) {
  return summary(data, 'load/results/api-intents.json');
}
