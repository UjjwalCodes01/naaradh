import { describe, expect, it } from 'vitest';
import { isPrivateAddress, webhookUrlProblem } from '../src/webhook-url.js';

describe('webhookUrlProblem (merchant webhook destinations, SSRF)', () => {
  it('accepts a public https hostname', () => {
    expect(webhookUrlProblem('https://hooks.example.com/naaradh')).toBeNull();
    expect(webhookUrlProblem('https://api.client-b.in:443/x?y=1')).toBeNull();
  });

  it.each([
    ['http://hooks.example.com/x', 'https'],
    ['https://user:pw@hooks.example.com/x', 'credentials'],
    ['https://hooks.example.com:8443/x', 'port'],
    ['https://10.0.0.5/x', 'IP address'],
    ['https://[::1]/x', 'IP address'],
    ['https://169.254.169.254/computeMetadata/v1/', 'IP address'],
    ['https://localhost/x', 'not allowed'],
    ['https://voice/x', 'public hostname'],
    ['https://hooks-abc123-el.a.run.app/shopify/webhooks', 'not allowed'],
    ['https://metadata.google.internal/x', 'not allowed'],
    ['https://storage.googleapis.com/x', 'not allowed'],
    ['https://api.naaradh.com/v1/intents', 'not allowed'],
    ['https://printer.local/x', 'not allowed'],
    ['not a url', 'absolute URL'],
  ])('refuses %s', (url, why) => {
    expect(webhookUrlProblem(url)).toContain(why);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    '::ffff:10.0.0.1',
    'ff02::1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('%s is private or invalid', (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (a) => {
      expect(isPrivateAddress(a)).toBe(false);
    },
  );
});
