import { ROLES, listSessions, listUsers, roleAtLeast } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, PageHeader, Table, Td, inputClass } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { invite, removeUser, setRole, signOutEverywhere } from './actions';

const ROLE_HELP: Record<string, string> = {
  viewer: 'Sees calls, tickets and billing',
  operator: 'Also works tickets, the knowledge base and opt-outs; can play recordings',
  manager: 'Also changes settings, the support agent, scripts and the team',
  owner: 'Everything, including API keys and billing',
};

export default async function Team() {
  const s = await requireSession('manager');
  const tz = (await tenantSettings()).timezone;
  const [users, sessions] = await inTenant(
    s,
    async (tx) =>
      [await listUsers(tx, s.tenantId), await listSessions(tx, s.tenantId, s.userId)] as const,
  );
  const isOwner = roleAtLeast(s.role, 'owner');
  const assignable = ROLES.filter((r) => r !== 'owner' || isOwner);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Everyone signs in with their own email. Roles decide who can listen to recordings and change settings; every change is in the access log."
      />
      <Card title="Invite someone">
        <ActionForm action={invite} submit="Invite">
          <div className="grid gap-3 sm:grid-cols-3">
            <input
              name="email"
              type="email"
              required
              placeholder="name@yourstore.com"
              className={inputClass}
            />
            <input
              name="name"
              maxLength={120}
              placeholder="Name (optional)"
              className={inputClass}
            />
            <select name="role" defaultValue="operator" className={inputClass}>
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {r} — {ROLE_HELP[r]}
                </option>
              ))}
            </select>
          </div>
        </ActionForm>
      </Card>
      <Table head={['Person', 'Role', 'Last sign-in', '']}>
        {users.map((u) => (
          <tr key={u.id} className={u.disabledAt === null ? '' : 'opacity-50'}>
            <Td>
              <div className="font-medium">{u.name ?? u.email}</div>
              {u.name === null ? null : <div className="text-xs text-slate-500">{u.email}</div>}
            </Td>
            <Td>
              {u.disabledAt !== null ? (
                <Badge>Removed</Badge>
              ) : u.id === s.userId || (u.role === 'owner' && !isOwner) ? (
                <Badge>{u.role}</Badge>
              ) : (
                <ActionForm action={setRole} submit="Change">
                  <input type="hidden" name="user_id" value={u.id} />
                  <select name="role" defaultValue={u.role} className={`${inputClass} mt-0`}>
                    {assignable.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </ActionForm>
              )}
            </Td>
            <Td>{formatDateTime(u.lastLoginAt, tz)}</Td>
            <Td>
              {u.disabledAt === null && u.id !== s.userId && (u.role !== 'owner' || isOwner) ? (
                <ActionForm
                  action={removeUser}
                  submit="Remove"
                  danger
                  confirm={`Remove ${u.email} and sign them out?`}
                >
                  <input type="hidden" name="user_id" value={u.id} />
                </ActionForm>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>
      <Card title="Your sessions">
        <ul className="mb-3 space-y-1 text-sm text-slate-600">
          {sessions.map((x) => (
            <li key={x.id}>
              {x.id === s.sessionId ? <Badge tone="good">This browser</Badge> : null}{' '}
              {x.userAgent ?? 'Unknown browser'} · last active {formatDateTime(x.lastSeenAt, tz)}
            </li>
          ))}
        </ul>
        <ActionForm action={signOutEverywhere} submit="Sign out everywhere" danger />
      </Card>
    </div>
  );
}
