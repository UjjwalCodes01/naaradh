/**
 * Recordings and transcripts live in our GCS bucket (E-34). The dashboard never proxies audio:
 * it hands the browser a V4 signed URL valid for 15 minutes, after the access has been
 * written to audit_log (pipeline accessMedia). Transcripts are small JSON and are read
 * server-side so they render as text.
 */
export interface Turn {
  readonly role: 'agent' | 'customer';
  readonly text: string;
  readonly startMs: number;
}

export interface MediaStore {
  signedUrl(uri: string, ttlSec: number): Promise<string>;
  readTranscript(uri: string): Promise<Turn[]>;
}

function parseGs(uri: string): { bucket: string; name: string } {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (m === null || m[1] === undefined || m[2] === undefined) throw new Error('not a gs:// uri');
  return { bucket: m[1], name: m[2] };
}

function toTurns(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((t: unknown) => {
    if (t === null || typeof t !== 'object') return [];
    const o = t as Record<string, unknown>;
    if (typeof o['text'] !== 'string') return [];
    return [
      {
        role: o['role'] === 'agent' ? 'agent' : 'customer',
        text: o['text'].slice(0, 4000),
        startMs: typeof o['startMs'] === 'number' ? o['startMs'] : 0,
      },
    ];
  });
}

export function gcsMediaStore(): MediaStore {
  const storage = async () => new (await import('@google-cloud/storage')).Storage();
  return {
    async signedUrl(uri, ttlSec) {
      const { bucket, name } = parseGs(uri);
      const [url] = await (
        await storage()
      )
        .bucket(bucket)
        .file(name)
        .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlSec * 1000 });
      return url;
    },
    async readTranscript(uri) {
      const { bucket, name } = parseGs(uri);
      const [buf] = await (await storage()).bucket(bucket).file(name).download();
      return toTurns(JSON.parse(buf.toString('utf8')));
    },
  };
}

/** Dev/test: shaped like the real thing, points at nothing. */
export function devMediaStore(): MediaStore {
  return {
    async signedUrl(uri, ttlSec) {
      return `${uri.replace(/^(gs|mem):\/\//, 'https://storage.invalid/')}?signed=dev&expires_in=${String(ttlSec)}`;
    },
    async readTranscript() {
      return [
        { role: 'agent', text: '(dev) Transcript storage is not configured locally.', startMs: 0 },
      ];
    },
  };
}
