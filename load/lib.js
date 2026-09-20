import crypto from 'k6/crypto';
import { fail } from 'k6';

/**
 * Shared helpers for the k6 scripts (P3-INF-4). STAGING ONLY: every script refuses a target
 * that is not on stage.naaradh.com or localhost, and every phone number it sends is in the
 * reserved fake range (shared/test/fake-phones.ts), which is the only range the
 * simulator engine will dial. Never point these at production or at a real number.
 */

export function baseUrl(name) {
  const url = __ENV[name];
  if (!url) fail(`${name} is required (e.g. https://hooks.stage.naaradh.com)`);
  const host = url
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
  const ok = host.endsWith('.stage.naaradh.com') || host === 'localhost' || host === '127.0.0.1';
  if (!ok) fail(`${name}=${url} is not a staging host; load tests never target production`);
  return url.replace(/\/$/, '');
}

export function required(name) {
  const v = __ENV[name];
  if (!v) fail(`${name} is required`);
  return v;
}

/** `+91 60000 00xxx`: deterministic per VU/iteration, always inside the fake range. */
export function fakePhone(n) {
  return `+9160000${String(n % 100000).padStart(5, '0')}`;
}

export function hmacHex(secret, body) {
  return crypto.hmac('sha256', secret, body, 'hex');
}

export function hmacBase64(secret, body) {
  return crypto.hmac('sha256', secret, body, 'base64');
}

export function summary(data, file) {
  return {
    stdout: textSummary(data),
    [file]: JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const line = (name) => {
    const v = m[name] && m[name].values;
    if (!v) return `${name}: n/a`;
    return `${name}: p95=${fmt(v['p(95)'])} p99=${fmt(v['p(99)'])} avg=${fmt(v.avg)} max=${fmt(v.max)}`;
  };
  const failed = m.http_req_failed ? m.http_req_failed.values.rate : 0;
  return [
    '',
    line('http_req_duration'),
    line('inbound_context_ms'),
    line('tool_call_ms'),
    `http_req_failed: ${(failed * 100).toFixed(2)}%`,
    `requests: ${m.http_reqs ? m.http_reqs.values.count : 0}`,
    '',
  ].join('\n');
}

const fmt = (n) => (typeof n === 'number' ? `${n.toFixed(0)}ms` : 'n/a');
