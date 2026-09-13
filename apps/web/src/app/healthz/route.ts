export const dynamic = 'force-dynamic';

/** Liveness at the path every service uses (uptime checks, deploy smoke). No dependencies touched. */
export function GET() {
  return Response.json({ ok: true });
}
