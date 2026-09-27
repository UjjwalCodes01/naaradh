import { NextResponse } from 'next/server';
import {
  AUDIT_CSV_HEADER,
  AUDIT_CSV_MAX_ROWS,
  audit,
  auditCsvLine,
  auditExportRange,
  exportAuditLog,
  roleAtLeast,
} from '@naaradh/pipeline';
import { isNaaradhError } from '@naaradh/shared';
import { allow } from '@/lib/rate-limit';
import { currentSession, inTenant } from '@/lib/session';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The access log as CSV for an auditor (P7-ENT-1). Manager role and above — the same people who
 * can read the log on screen. `from`/`to` are calendar days in UTC, both inclusive; the default
 * is the last 90 days. Streamed a page at a time, so a large export never sits in memory, and
 * cut off at AUDIT_CSV_MAX_ROWS with a final line saying so rather than silently.
 *
 * Exporting the log is itself an access event and is audited before the first byte is sent.
 */
export async function GET(req: Request) {
  const s = await currentSession();
  if (s === null) return new NextResponse('Sign in required', { status: 401 });
  if (!roleAtLeast(s.role, 'manager'))
    return new NextResponse('Not allowed for your role', { status: 403 });
  if (!(await allow(`audit-export:${s.tenantId}`, 20, 3600)))
    return new NextResponse('Too many exports this hour. Try again later.', { status: 429 });

  const params = new URL(req.url).searchParams;
  const today = new Date(new Date().toISOString().slice(0, 10));
  const fromDay = params.get('from') ?? '';
  const toDay = params.get('to') ?? '';
  const from = DAY.test(fromDay)
    ? new Date(`${fromDay}T00:00:00Z`)
    : new Date(today.getTime() - 89 * 86_400_000);
  const toStart = DAY.test(toDay) ? new Date(`${toDay}T00:00:00Z`) : today;
  const to = new Date(toStart.getTime() + 86_400_000);
  try {
    auditExportRange(from, to);
  } catch (error) {
    if (isNaaradhError(error)) return new NextResponse(error.message, { status: 400 });
    throw error;
  }

  await inTenant(s, (tx) =>
    audit(tx, {
      tenantId: s.tenantId,
      actorType: 'user',
      actorId: s.userId,
      action: 'audit_log.exported',
      targetType: 'tenant',
      targetId: s.tenantId,
      after: { from: from.toISOString(), to: to.toISOString(), via: 'dashboard' },
    }),
  );

  const encoder = new TextEncoder();
  let cursor: string | null = null;
  let sent = 0;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(`${AUDIT_CSV_HEADER.join(',')}\r\n`));
        return;
      }
      const after = cursor;
      const page = await inTenant(s, (tx) =>
        exportAuditLog(tx, s.tenantId, { from, to }, { after }),
      );
      const room = AUDIT_CSV_MAX_ROWS - sent;
      const rows = page.rows.slice(0, room);
      if (rows.length > 0)
        controller.enqueue(encoder.encode(`${rows.map(auditCsvLine).join('\r\n')}\r\n`));
      sent += rows.length;
      cursor = page.next;
      if (cursor !== null && sent >= AUDIT_CSV_MAX_ROWS) {
        controller.enqueue(
          encoder.encode(
            `"# truncated at ${String(AUDIT_CSV_MAX_ROWS)} rows — export a shorter range for the rest"\r\n`,
          ),
        );
        controller.close();
      } else if (cursor === null) controller.close();
    },
  });

  const name = `naaradh-audit-${from.toISOString().slice(0, 10)}-to-${toStart.toISOString().slice(0, 10)}.csv`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
