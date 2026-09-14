import { isIP } from 'node:net';

/**
 * Merchant-supplied webhook destinations (AGENTS §8, §11 "every new outbound integration").
 * The deliveries worker POSTs to whatever a merchant registered, from inside our VPC — so a
 * destination must never be able to reach our own services, the metadata server, or anything
 * private. Two layers: this syntactic check at registration, and an address check just before
 * the connection is opened (`isPrivateAddress` on the resolved IPs, apps/workers deliveries).
 */

const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  // Google Cloud internal names (Cloud Run services, metadata, private Google access).
  '.run.app',
  '.googleapis.com',
  'metadata.google.internal',
  '.naaradh.com',
];

/** Null when the URL is acceptable; otherwise a sentence for the merchant. */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials';
  if (url.port !== '' && url.port !== '443') return 'must use port 443';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return 'must have a hostname';
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) return 'must be a hostname, not an IP address';
  for (const suffix of BLOCKED_HOST_SUFFIXES)
    if (host === suffix.replace(/^\./, '') || host.endsWith(suffix))
      return 'hostname is not allowed';
  if (!host.includes('.')) return 'must be a public hostname';
  return null;
}

/**
 * True for loopback, link-local (incl. the 169.254.169.254 metadata server), RFC 1918,
 * CGNAT, unique-local IPv6, unspecified and multicast addresses — anything a webhook must
 * never be delivered to, whatever the DNS name said.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return true;
}

function isPrivateV4(a: string): boolean {
  const parts = a.split('.').map(Number);
  const [p0 = 0, p1 = 0] = parts;
  if (p0 === 0 || p0 === 10 || p0 === 127) return true;
  if (p0 === 100 && p1 >= 64 && p1 <= 127) return true; // CGNAT 100.64/10
  if (p0 === 169 && p1 === 254) return true; // link-local + metadata server
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
  if (p0 === 192 && p1 === 168) return true;
  if (p0 === 192 && p1 === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF
  if (p0 === 198 && (p1 === 18 || p1 === 19)) return true; // benchmarking
  if (p0 >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateV6(a: string): boolean {
  const lower = a.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) return isPrivateV4(lower.slice('::ffff:'.length));
  if (
    lower.startsWith('fe80:') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  )
    return true; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 well-known prefix
  return false;
}
