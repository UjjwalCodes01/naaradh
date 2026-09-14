/**
 * RFC 9116 security.txt (SPEC §14, §7 mailboxes): how to report a vulnerability.
 *
 * `Expires` is a fixed timestamp on purpose (the RFC wants a value that changes only when a
 * human re-affirms the file). BUMP IT before 2027-09-13 — an expired file is treated as absent by
 * scanners and researchers. Acknowledgments is deliberately omitted (no hall of fame yet).
 */
const SECURITY_TXT = [
  'Contact: mailto:security@naaradh.com',
  'Expires: 2027-09-13T00:00:00.000Z',
  'Preferred-Languages: en, hi',
  'Policy: https://naaradh.com/security',
  'Canonical: https://naaradh.com/.well-known/security.txt',
  '',
].join('\n');

export function GET() {
  return new Response(SECURITY_TXT, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
