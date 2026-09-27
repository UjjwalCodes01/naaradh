import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from './webhook-url.js';

/**
 * Outbound fetches to a URL someone else chose — a recording URL in an engine's call record, a
 * merchant's single sign-on issuer — run from inside our VPC. Nothing such a URL says may reach
 * our own services, the metadata server or a private address.
 *
 * Unlike merchant webhooks (`webhookUrlProblem`), `*.googleapis.com` is allowed here: recordings
 * are hosted on GCS and S3, and Google's own OpenID endpoints live there. Our own hosts and every
 * internal name stay refused.
 */
export class EgressRefusedError extends Error {
  override readonly name: string = 'EgressRefusedError';
}

const BLOCKED_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  'metadata.google.internal',
  '.run.app',
  '.naaradh.com',
];

export type Resolver = (hostname: string) => Promise<readonly string[]>;

export const dnsResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Parses and checks `raw`: https on 443, no credentials, a public hostname that resolves only to
 * public addresses. `what` names the URL in the error ("recording URL", "issuer URL").
 */
export async function assertPublicHttpsUrl(
  raw: string,
  what: string,
  resolve: Resolver = dnsResolver,
  ErrorClass: new (message: string) => Error = EgressRefusedError,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ErrorClass(`${what} is not absolute`);
  }
  if (url.protocol !== 'https:') throw new ErrorClass(`${what} is not https`);
  if (url.username !== '' || url.password !== '')
    throw new ErrorClass(`${what} carries credentials`);
  if (url.port !== '' && url.port !== '443')
    throw new ErrorClass(`${what} uses a non-standard port`);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) throw new ErrorClass(`${what} is an IP address`);
  for (const suffix of BLOCKED_SUFFIXES)
    if (host === suffix.replace(/^\./, '') || host.endsWith(suffix))
      throw new ErrorClass(`${what} host is not allowed`);
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new ErrorClass(`${what} host does not resolve`);
  }
  if (addresses.length === 0) throw new ErrorClass(`${what} host does not resolve`);
  if (addresses.some(isPrivateAddress))
    throw new ErrorClass(`${what} host resolves to a private address`);
  return url;
}
