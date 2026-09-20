import { listCalendars, upcomingAppointments } from '@naaradh/pipeline';
import { Badge, Card, Empty, PageHeader, Table, Td, TextLink } from '@/components/ui';
import { formatDateTime, humanise } from '@/lib/format';
import { now } from '@/lib/server';
import { inTenant, requireSession } from '@/lib/session';

/**
 * Appointments (ADR-0011 §7): the diary Naaradh will call about, and what it decided for each
 * one. Read-only — appointments come from the merchant's own system or calendar, and connecting
 * a calendar needs a credential, which Naaradh staff store in Secret Manager.
 */
export default async function Appointments() {
  const s = await requireSession();
  const from = now();
  const [calendars, appointments] = await inTenant(s, async (tx) => [
    await listCalendars(tx, s.tenantId),
    await upcomingAppointments(tx, s.tenantId, from, 100),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appointments"
        description="Naaradh calls once before each appointment — between 24 and 2 hours ahead, inside 09:00–21:00 where the customer is. Confirmed, moved or cancelled on the call, it is updated here and in your calendar."
      />

      <Card title="Connected calendars">
        {calendars.length === 0 ? (
          <p className="text-sm text-slate-600">
            No calendar connected. Appointments you send with the API still get a confirmation call;
            a calendar is only needed for the agent to offer free times on a call. Ask support to
            connect one.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {calendars.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <span className="text-slate-500">
                  {c.provider} · {String(c.slotMinutes)}-minute slots · {c.timezone}
                </span>
                <Badge
                  tone={c.status === 'active' ? 'good' : c.status === 'error' ? 'bad' : 'neutral'}
                >
                  {c.status}
                </Badge>
                {c.lastError === null ? null : (
                  <span className="text-xs text-rose-700">{c.lastError}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {appointments.length === 0 ? (
        <Empty>
          No appointments in the diary. Send them with <code>PUT /v1/appointments/{'{ref}'}</code>{' '}
          (API keys and the reference are under{' '}
          <TextLink href="/app/developers">Developers</TextLink>) or connect a calendar.
        </Empty>
      ) : (
        <Table head={['When', 'Service', 'Status', 'Confirmation call']}>
          {appointments.map((a) => (
            <tr key={a.id} className="border-t border-slate-100">
              <Td>
                {formatDateTime(a.startsAt, a.timezone)}
                <div className="text-xs text-slate-500">{a.timezone}</div>
              </Td>
              <Td>
                {a.service ?? '—'}
                <div className="text-xs text-slate-500">{a.ref}</div>
              </Td>
              <Td>
                <Badge
                  tone={
                    a.status === 'confirmed'
                      ? 'good'
                      : a.status === 'cancelled' || a.status === 'no_show'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {humanise(a.status)}
                </Badge>
                {a.providerError === null ? null : (
                  <div className="text-xs text-rose-700">Calendar: {a.providerError}</div>
                )}
              </Td>
              <Td>
                {a.intentId !== null ? (
                  <span className="text-slate-700">Queued</span>
                ) : a.reminderDecidedAt === null ? (
                  <span className="text-slate-500">Not due yet</span>
                ) : (
                  <span className="text-slate-500">
                    No call — see Order calls for the reason, or the customer has no phone number
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
