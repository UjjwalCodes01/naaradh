import { describe, expect, it } from 'vitest';
import {
  UnsafeRecordingSourceError,
  assertSafeRecordingSource,
  safeFetcher,
  type Resolver,
} from '../src/results/recordings.js';

/**
 * The recording URL comes from an engine's call record and is fetched from inside our VPC.
 * Nothing it says may reach a private address, and no file may be big enough to sink a worker.
 */

const PUBLIC: Resolver = async () => ['34.117.59.81'];
const table =
  (map: Record<string, string>): Resolver =>
  async (host) => [map[host] ?? '34.117.59.81'];

const audio = (bytes = 16, init: ResponseInit = {}) =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
    ...init,
  });

describe('assertSafeRecordingSource', () => {
  it.each([
    ['http://cdn.vendor.example/a.mp3', /not https/],
    ['https://user:pw@cdn.vendor.example/a.mp3', /credentials/],
    ['https://cdn.vendor.example:8443/a.mp3', /non-standard port/],
    ['https://10.0.0.5/a.mp3', /IP address/],
    ['https://[::1]/a.mp3', /IP address/],
    ['https://metadata.google.internal/computeMetadata/v1/', /not allowed/],
    ['https://voice-abc.a.run.app/a.mp3', /not allowed/],
    ['https://hooks.naaradh.com/a.mp3', /not allowed/],
    ['https://localhost/a.mp3', /not allowed/],
  ])('refuses %s', async (url, why) => {
    await expect(assertSafeRecordingSource(url, PUBLIC)).rejects.toThrow(why);
  });

  it('refuses a public name that resolves to the metadata server (DNS pointed inward)', async () => {
    await expect(
      assertSafeRecordingSource('https://evil.example/a.mp3', async () => ['169.254.169.254']),
    ).rejects.toThrow(/private address/);
  });

  it('refuses when any one of several addresses is private', async () => {
    await expect(
      assertSafeRecordingSource('https://evil.example/a.mp3', async () => [
        '34.117.59.81',
        '10.8.0.3',
      ]),
    ).rejects.toThrow(/private address/);
  });

  it('accepts a public vendor host, including public objects on GCS', async () => {
    await expect(
      assertSafeRecordingSource('https://storage.googleapis.com/bucket/call.wav', PUBLIC),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe('safeFetcher', () => {
  it('downloads a recording from a public host', async () => {
    const f = safeFetcher(PUBLIC, async () => audio(32));
    const res = await f('https://cdn.vendor.example/a.mp3');
    expect(res).toMatchObject({ ok: true, status: 200, contentType: 'audio/mpeg' });
    expect(res.body.byteLength).toBe(32);
  });

  it('refuses a redirect that points at the metadata server', async () => {
    const f = safeFetcher(
      table({ 'inward.example': '169.254.169.254' }),
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://inward.example/computeMetadata/v1/' },
        }),
    );
    await expect(f('https://cdn.vendor.example/a.mp3')).rejects.toThrow(UnsafeRecordingSourceError);
  });

  it('sends the adapter credentials to the original origin only, never after a redirect', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const f = safeFetcher(PUBLIC, async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const auth = new Headers(init?.headers).get('authorization');
      seen.push({ url, auth });
      return url.startsWith('https://api.vendor.example')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.other.example/a.mp3' },
          })
        : audio();
    });
    await f('https://api.vendor.example/rec/1', { authorization: 'Bearer key_live' });
    expect(seen[0]).toMatchObject({ auth: 'Bearer key_live' });
    expect(seen[1]).toMatchObject({ url: 'https://cdn.other.example/a.mp3', auth: null });
  });

  it('gives up after three redirects', async () => {
    let n = 0;
    const f = safeFetcher(
      PUBLIC,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://hop${String(++n)}.example/a.mp3` },
        }),
    );
    await expect(f('https://cdn.vendor.example/a.mp3')).rejects.toThrow(/redirects too many/);
  });

  it('refuses a body larger than the cap on its declared length, before reading it', async () => {
    const f = safeFetcher(
      PUBLIC,
      async () => audio(8, { headers: { 'content-length': '999' } }),
      100,
    );
    await expect(f('https://cdn.vendor.example/a.mp3')).rejects.toThrow(/larger than the limit/);
  });

  it('refuses a body that grows past the cap without declaring its length', async () => {
    const f = safeFetcher(PUBLIC, async () => audio(500), 100);
    await expect(f('https://cdn.vendor.example/a.mp3')).rejects.toThrow(/larger than the limit/);
  });

  it('passes a vendor error through as not-ok, without reading the body', async () => {
    const f = safeFetcher(PUBLIC, async () => new Response('gone', { status: 404 }));
    await expect(f('https://cdn.vendor.example/a.mp3')).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
  });
});
