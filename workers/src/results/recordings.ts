import { Storage } from '@google-cloud/storage';
import {
  EgressRefusedError,
  assertPublicHttpsUrl,
  dnsResolver,
  type Resolver,
} from '@naaradh/shared';

/**
 * E-34: vendor recording URLs expire; the recording is copied into OUR bucket within 10
 * minutes of call.ended and the vendor URL is never stored or shown. Transcripts go beside
 * it as JSON. Object names carry tenant and attempt ids only — never a phone number.
 */
export interface RecordingStore {
  /** `headers`: the engine adapter's own credentials for ITS recording host, when it needs them. */
  persistRecording(
    tenantId: string,
    attemptId: string,
    sourceUrl: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<string>;
  persistTranscript(tenantId: string, attemptId: string, transcript: unknown): Promise<string>;
  delete(uri: string): Promise<void>;
}

export type Fetcher = (
  url: string,
  headers?: Readonly<Record<string, string>>,
) => Promise<{ ok: boolean; status: number; body: Buffer; contentType: string | null }>;

/**
 * The URL comes from an engine's call record, and this fetch runs inside our VPC. A signed or
 * re-fetched record makes a hostile URL unlikely, but "the vendor was compromised" is exactly
 * the case this exists for: nothing a call record says may reach our own services, the
 * metadata server or a private address, and no file may be large enough to take a worker down.
 *
 * Unlike merchant webhooks (`webhookUrlProblem`), `*.googleapis.com` is allowed: vendors host
 * recordings on GCS and S3, and a public object there is a legitimate source.
 */
export class UnsafeRecordingSourceError extends EgressRefusedError {
  override readonly name = 'UnsafeRecordingSourceError';
}

/** A 30-minute stereo 44.1 kHz WAV is ~320 MB; nothing we record is longer than 30 minutes. */
export const MAX_RECORDING_BYTES = 384 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export type { Resolver };

export function assertSafeRecordingSource(
  raw: string,
  resolve: Resolver = dnsResolver,
): Promise<URL> {
  return assertPublicHttpsUrl(raw, 'recording URL', resolve, UnsafeRecordingSourceError);
}

/** Reads a body, refusing it the moment it passes `max` bytes instead of after buffering it. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max)
    throw new UnsafeRecordingSourceError('recording is larger than the limit');
  if (res.body === null) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new UnsafeRecordingSourceError('recording is larger than the limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function safeFetcher(
  resolve: Resolver = dnsResolver,
  doFetch: typeof fetch = fetch,
  maxBytes = MAX_RECORDING_BYTES,
): Fetcher {
  return async (url, headers) => {
    let current = await assertSafeRecordingSource(url, resolve);
    const origin = current.origin;
    // Every hop is checked again; the adapter's credentials go only to the origin they were
    // issued for, never to wherever a redirect points.
    for (let hop = 0; ; hop++) {
      const res = await doFetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
        ...(headers !== undefined && current.origin === origin ? { headers } : {}),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location === null || hop >= MAX_REDIRECTS)
          throw new UnsafeRecordingSourceError('recording redirects too many times');
        current = await assertSafeRecordingSource(new URL(location, current).href, resolve);
        continue;
      }
      return {
        ok: res.ok,
        status: res.status,
        body: res.ok ? await readCapped(res, maxBytes) : Buffer.alloc(0),
        contentType: res.headers.get('content-type'),
      };
    }
  };
}

export const nodeFetcher: Fetcher = safeFetcher();

export function gcsRecordingStore(
  bucketName: string,
  fetcher: Fetcher = nodeFetcher,
): RecordingStore {
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  return {
    async persistRecording(tenantId, attemptId, sourceUrl, headers) {
      const res = await fetcher(sourceUrl, headers);
      if (!res.ok) throw new Error(`recording download failed: HTTP ${String(res.status)}`);
      const ext = res.contentType?.includes('wav') === true ? 'wav' : 'mp3';
      const name = `${tenantId}/${attemptId}/recording.${ext}`;
      await bucket.file(name).save(res.body, {
        contentType: res.contentType ?? 'audio/mpeg',
        resumable: false,
        metadata: { cacheControl: 'private, max-age=0' },
      });
      return `gs://${bucketName}/${name}`;
    },
    async persistTranscript(tenantId, attemptId, transcript) {
      const name = `${tenantId}/${attemptId}/transcript.json`;
      await bucket
        .file(name)
        .save(JSON.stringify(transcript), { contentType: 'application/json', resumable: false });
      return `gs://${bucketName}/${name}`;
    },
    async delete(uri) {
      const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
      if (m === null || m[1] !== bucketName || m[2] === undefined) return;
      await bucket.file(m[2]).delete({ ignoreNotFound: true });
    },
  };
}

/** Tests and `pnpm dev` without GCS: objects live in memory, URIs look real. */
export function memoryRecordingStore(
  fetcher?: Fetcher,
): RecordingStore & { objects: Map<string, Buffer | string> } {
  const objects = new Map<string, Buffer | string>();
  const fetchIt: Fetcher =
    fetcher ??
    (async () => ({
      ok: true,
      status: 200,
      body: Buffer.from('RIFF-fake-audio'),
      contentType: 'audio/mpeg',
    }));
  return {
    objects,
    async persistRecording(tenantId, attemptId, sourceUrl, headers) {
      const res = await fetchIt(sourceUrl, headers);
      if (!res.ok) throw new Error(`recording download failed: HTTP ${String(res.status)}`);
      const uri = `mem://recordings/${tenantId}/${attemptId}/recording.mp3`;
      objects.set(uri, res.body);
      return uri;
    },
    async persistTranscript(tenantId, attemptId, transcript) {
      const uri = `mem://recordings/${tenantId}/${attemptId}/transcript.json`;
      objects.set(uri, JSON.stringify(transcript));
      return uri;
    },
    async delete(uri) {
      objects.delete(uri);
    },
  };
}
