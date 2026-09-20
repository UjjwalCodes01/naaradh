import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@naaradh/db';
import { DirectorySnapshot, applyDirectorySnapshot, lookupRegion } from '@naaradh/pipeline';
import { verifyRegionSnapshot } from '@naaradh/shared';

/**
 * Region routing at the edge of hooks (ADR-0012 §4, P6-INF-2).
 *
 * A Shopify app has one webhook URL for every store, so every deployment receives webhooks for
 * shops another region serves. The body carries that region's customers' personal data, so it
 * must not be stored here: once the HMAC is verified (invariant 9), a webhook for a shop the
 * directory places elsewhere is passed through, byte for byte with Shopify's own headers, to
 * that region's hooks, which verifies it again. Our answer is the peer's, so Shopify's retry
 * behaviour is unchanged. A forwarded request is never forwarded again.
 *
 * The directory itself arrives here too: `POST /internal/region-directory`, a peer's full
 * snapshot. The sender names itself in `X-Naaradh-Region`; the body is verified against THAT
 * region's Ed25519 public key (`X-Naaradh-Signature: t=…,sig=…`, 5-minute window) before it is
 * parsed, and must then claim that same region as its source. A region can therefore publish
 * rows only for itself: it holds no other region's private key.
 */

export type Region = 'in' | 'us' | 'eu';
export const FORWARDED_FROM = 'x-naaradh-forwarded-from';
const FORWARD_TIMEOUT_MS = 3_500; // Shopify waits 5 s in total.

export interface RegionDeps {
  readonly db: Db;
  /** DATA_REGION of this deployment. */
  readonly region: Region;
  /** The other regions' hooks base URLs. Empty = single-region: nothing is forwarded. */
  readonly peers: Readonly<Partial<Record<Region, string>>>;
  /** REGION_PEER_KEYS: each peer's Ed25519 public key. Empty → the directory endpoint is 404. */
  readonly peerKeys: Readonly<Partial<Record<Region, string>>>;
  readonly fetchImpl?: typeof fetch;
  readonly nowUnix?: () => number;
}

/** The peer that serves this shop, when it is not us and we know where it is. */
export async function peerForShop(
  deps: RegionDeps,
  shop: string,
  request: FastifyRequest,
): Promise<{ region: Region; url: string } | null> {
  if (Object.keys(deps.peers).length === 0) return null;
  if (request.headers[FORWARDED_FROM] !== undefined) return null;
  const region = await lookupRegion(deps.db, 'shop', shop);
  if (region === null || region === deps.region) return null;
  const base = deps.peers[region];
  if (base === undefined) return null;
  return { region, url: new URL('/shopify/webhooks', base).href };
}

/** Pass a verified webhook through to its region; the peer's status becomes ours. */
export async function forwardToPeer(
  deps: RegionDeps,
  target: { region: Region; url: string },
  request: FastifyRequest,
  reply: FastifyReply,
  raw: Buffer,
): Promise<FastifyReply> {
  const headers: Record<string, string> = { [FORWARDED_FROM]: deps.region };
  for (const [k, v] of Object.entries(request.headers))
    if ((k.startsWith('x-shopify-') || k === 'content-type') && typeof v === 'string')
      headers[k] = v;
  try {
    const res = await (deps.fetchImpl ?? fetch)(target.url, {
      method: 'POST',
      headers,
      body: raw,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    request.log.info(
      { region: target.region, status: res.status, topic: headers['x-shopify-topic'] },
      'shopify webhook forwarded to its region',
    );
    // 2xx and 401 pass through as they are; anything else asks Shopify to retry.
    const status = res.ok || res.status === 401 ? res.status : 502;
    return await reply.code(status).send({ status: 'forwarded', region: target.region });
  } catch (error) {
    request.log.warn(
      { region: target.region, err: error instanceof Error ? error.name : 'unknown' },
      'shopify webhook forward failed',
    );
    return reply.code(502).send({ status: 'forward_failed', region: target.region });
  }
}

export function registerRegionRoutes(app: FastifyInstance, deps: RegionDeps): void {
  // A full snapshot of ~200k entries is ~10 MB; the default 1 MiB limit would 413 it.
  app.post('/internal/region-directory', { bodyLimit: 16 * 1_048_576 }, async (request, reply) => {
    const sender = request.headers['x-naaradh-region'];
    const key =
      typeof sender === 'string' && (sender === 'in' || sender === 'us' || sender === 'eu')
        ? deps.peerKeys[sender]
        : undefined;
    if (Object.keys(deps.peerKeys).length === 0)
      return reply.code(404).send({ error: 'not found' });
    if (key === undefined || sender === deps.region)
      return reply.code(403).send({ error: 'not a peer' });
    const raw = request.body as Buffer;
    const signature = request.headers['x-naaradh-signature'];
    const now = deps.nowUnix?.() ?? Math.floor(Date.now() / 1000);
    const verified = verifyRegionSnapshot(
      key,
      typeof signature === 'string' ? signature : undefined,
      raw.toString('utf8'),
      now,
    );
    if (!verified.ok) {
      request.log.warn(
        { sender, reason: verified.reason },
        'region directory rejected: bad signature',
      );
      return reply.code(401).send({ error: 'invalid signature' });
    }
    let parsed;
    try {
      parsed = DirectorySnapshot.safeParse(JSON.parse(raw.toString('utf8')));
    } catch {
      return reply.code(400).send({ error: 'body is not JSON' });
    }
    if (!parsed.success) return reply.code(400).send({ error: 'invalid snapshot' });
    const snapshot = parsed.data;
    // Signed by `sender`, so it may only speak for `sender`.
    if (snapshot.source !== sender) return reply.code(403).send({ error: 'source mismatch' });
    // A delayed or replayed older snapshot must not roll the directory back.
    if (Math.abs(now - Date.parse(snapshot.generated_at) / 1000) > 600)
      return reply.code(409).send({ error: 'stale snapshot' });
    const applied = await deps.db.transaction((tx) => applyDirectorySnapshot(tx, snapshot));
    request.log.info({ source: snapshot.source, ...applied }, 'region directory applied');
    return reply.code(200).send(applied);
  });
}
