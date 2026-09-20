export const dynamic = 'force-dynamic';

/** Liveness for the load balancer and uptime checks. No dependencies touched. */
export function GET() {
  return Response.json({ ok: true });
}
