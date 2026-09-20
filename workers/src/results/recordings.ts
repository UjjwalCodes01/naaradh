import { Storage } from '@google-cloud/storage';

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

export const nodeFetcher: Fetcher = async (url, headers) => {
  // fetch drops Authorization when a redirect leaves the origin, so a key never follows one.
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    ...(headers === undefined ? {} : { headers }),
  });
  return {
    ok: res.ok,
    status: res.status,
    body: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type'),
  };
};

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
