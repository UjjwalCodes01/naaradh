import {
  listComplaints,
  listErasureRequests,
  listSuppressions,
  roleAtLeast,
} from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Empty, PageHeader, Table, Td, inputClass } from '@/components/ui';
import { formatDate, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import {
  addSuppressionAction,
  checkNumberAction,
  fileErasureAction,
  liftSuppressionAction,
} from './actions';

export default async function Privacy() {
  const s = await requireSession('operator');
  const tz = (await tenantSettings()).timezone;
  const [suppressions, complaints, erasures] = await inTenant(
    s,
    async (tx) =>
      [
        await listSuppressions(tx, s.tenantId),
        await listComplaints(tx, s.tenantId),
        await listErasureRequests(tx, s.tenantId),
      ] as const,
  );
  const manager = roleAtLeast(s.role, 'manager');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Privacy & opt-outs"
        description="Numbers Naaradh must not call, complaints against your calls, and customers’ data-deletion requests. Numbers are stored only as irreversible fingerprints; the reference shows the last characters of that fingerprint."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Is a number blocked?">
          <ActionForm action={checkNumberAction} submit="Check">
            <input
              name="phone"
              type="tel"
              required
              placeholder="Phone number"
              className={inputClass}
            />
          </ActionForm>
        </Card>
        <Card title="Block a number">
          <ActionForm action={addSuppressionAction} submit="Block">
            <input
              name="phone"
              type="tel"
              required
              placeholder="Phone number"
              className={inputClass}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <select name="purpose" defaultValue="all" className={inputClass}>
                <option value="all">All calls</option>
                <option value="promotional">Promotional only</option>
                <option value="service">Service only</option>
                <option value="transactional">Order calls only</option>
              </select>
              <select name="reason" defaultValue="opt_out" className={inputClass}>
                <option value="opt_out">Customer asked us</option>
                <option value="manual">Our decision</option>
                <option value="wrong_number">Wrong number</option>
                <option value="invalid">Invalid number</option>
              </select>
            </div>
            <input
              name="notes"
              maxLength={500}
              placeholder="Note (optional, no personal data)"
              className={inputClass}
            />
          </ActionForm>
        </Card>
      </div>
      <Card title="Blocked by your team">
        {suppressions.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <Table head={['Reference', 'Calls blocked', 'Why', 'Until', '']}>
            {suppressions.map((x) => (
              <tr key={x.id}>
                <Td className="font-mono text-xs">{x.ref}</Td>
                <Td>{humanise(x.purpose)}</Td>
                <Td>{humanise(x.reason)}</Td>
                <Td>{x.until === null ? 'Indefinitely' : formatDate(x.until, tz)}</Td>
                <Td>
                  {manager && (x.reason === 'manual' || x.reason === 'invalid') ? (
                    <ActionForm action={liftSuppressionAction} submit="Lift" danger>
                      <input type="hidden" name="id" value={x.id} />
                      <input
                        name="reason"
                        required
                        minLength={10}
                        placeholder="Why (10+ characters)"
                        className={inputClass}
                      />
                    </ActionForm>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Complaints">
        {complaints.length === 0 ? (
          <Empty>No complaints. Three in ten days pause calling while Naaradh reviews.</Empty>
        ) : (
          <Table head={['Received', 'Source', 'Status']}>
            {complaints.map((c) => (
              <tr key={c.id}>
                <Td>{formatDate(c.receivedAt, tz)}</Td>
                <Td>{humanise(c.source)}</Td>
                <Td>
                  <Badge tone={c.status === 'invalid' ? 'neutral' : 'warning'}>{c.status}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Data deletion requests">
        {manager ? (
          <ActionForm action={fileErasureAction} submit="Request deletion" className="mb-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                name="phone"
                type="tel"
                required
                placeholder="Customer’s phone number"
                className={inputClass}
              />
              <input
                name="external_ref"
                maxLength={200}
                placeholder="Your reference (optional)"
                className={inputClass}
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" name="verified" className="mt-1" />I have verified this request
              comes from the customer. Deletion removes their recordings, transcripts, name and
              order details from Naaradh and cannot be undone.
            </label>
          </ActionForm>
        ) : null}
        {erasures.length === 0 ? null : (
          <Table head={['Requested', 'From', 'Status', 'Due', 'Completed']}>
            {erasures.map((e) => (
              <tr key={e.id}>
                <Td>{formatDate(e.requestedAt, tz)}</Td>
                <Td>{humanise(e.source)}</Td>
                <Td>
                  <Badge
                    tone={
                      e.status === 'completed' ? 'good' : e.status === 'failed' ? 'bad' : 'neutral'
                    }
                  >
                    {humanise(e.status)}
                  </Badge>
                </Td>
                <Td>{formatDate(e.dueAt, tz)}</Td>
                <Td>{formatDate(e.completedAt, tz)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
