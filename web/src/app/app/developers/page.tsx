import { API_SCOPES, listApiKeys, webhookHealth } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Empty, PageHeader, Table, Td, inputClass } from '@/components/ui';
import { formatDateTime, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { createKey, revokeKey } from './actions';

export default async function Developers() {
  const s = await requireSession('owner');
  const tz = (await tenantSettings()).timezone;
  const [keys, hooks] = await inTenant(
    s,
    async (tx) => [await listApiKeys(tx, s.tenantId), await webhookHealth(tx, s.tenantId)] as const,
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Developers"
        description="API keys for api.naaradh.com and the health of your webhook endpoints. Create endpoints with POST /v1/webhooks — the signing secret is returned once."
      />
      <Card title="New API key">
        <ActionForm action={createKey} submit="Create key">
          <div className="grid gap-3 sm:grid-cols-4">
            <input
              name="name"
              required
              maxLength={80}
              placeholder="Name, e.g. Order backend"
              className={inputClass}
            />
            <select name="kind" defaultValue="secret" className={inputClass}>
              <option value="secret">Secret (server)</option>
              <option value="public">Public site key (website snippet)</option>
            </select>
            <select name="env" defaultValue="live" className={inputClass}>
              <option value="live">Live</option>
              <option value="test">Test</option>
            </select>
            <input
              name="daily_cap"
              type="number"
              min={1}
              placeholder="Daily call cap (optional)"
              className={inputClass}
            />
          </div>
          <input
            name="domains"
            placeholder="Public keys: allowed domains, e.g. shop.example.com"
            className={inputClass}
          />
          <fieldset className="grid gap-1 sm:grid-cols-3">
            <legend className="text-sm font-medium text-slate-800">Scopes (secret keys)</legend>
            {API_SCOPES.map((sc) => (
              <label key={sc} className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  name="scopes"
                  value={sc}
                  defaultChecked={sc === 'intents:create' || sc === 'intents:read'}
                />
                {sc}
              </label>
            ))}
          </fieldset>
        </ActionForm>
      </Card>
      <Card title="Keys">
        {keys.length === 0 ? (
          <Empty>No keys.</Empty>
        ) : (
          <Table head={['Name', 'Key', 'Scopes', 'Last used', '']}>
            {keys.map((k) => (
              <tr key={k.id}>
                <Td>
                  {k.name} <Badge>{k.kind}</Badge>
                </Td>
                <Td className="font-mono text-xs">{k.prefix}…</Td>
                <Td className="max-w-xs whitespace-normal text-xs">{k.scopes.join(', ')}</Td>
                <Td>{formatDateTime(k.lastUsedAt, tz)}</Td>
                <Td>
                  <ActionForm
                    action={revokeKey}
                    submit="Revoke"
                    danger
                    confirm="Revoke this key? Anything using it stops working."
                  >
                    <input type="hidden" name="id" value={k.id} />
                    <input type="hidden" name="reason" value="revoked in dashboard" />
                  </ActionForm>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Webhook endpoints">
        {hooks.hooks.length === 0 ? (
          <Empty>No endpoints.</Empty>
        ) : (
          <Table head={['URL', 'Events', 'Status']}>
            {hooks.hooks.map((h) => (
              <tr key={h.id}>
                <Td className="max-w-xs truncate font-mono text-xs">{h.url}</Td>
                <Td className="max-w-sm whitespace-normal text-xs">{h.events.join(', ')}</Td>
                <Td>
                  {h.active ? (
                    <Badge tone={h.consecutiveFailures > 0 ? 'warning' : 'good'}>
                      {h.consecutiveFailures > 0
                        ? `${String(h.consecutiveFailures)} failures`
                        : 'Healthy'}
                    </Badge>
                  ) : (
                    <Badge tone="bad">
                      Disabled{h.disabledReason === null ? '' : `: ${h.disabledReason}`}
                    </Badge>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {hooks.deliveries.length === 0 ? null : (
          <div className="mt-4">
            <Table head={['Event', 'Status', 'Attempts', 'Last HTTP', 'When']}>
              {hooks.deliveries.map((d) => (
                <tr key={d.id}>
                  <Td>{d.eventType}</Td>
                  <Td>
                    <Badge
                      tone={
                        d.status === 'delivered' ? 'good' : d.status === 'dead' ? 'bad' : 'warning'
                      }
                    >
                      {humanise(d.status)}
                    </Badge>
                  </Td>
                  <Td>{d.attempts}</Td>
                  <Td>{d.lastStatusCode ?? '—'}</Td>
                  <Td>{formatDateTime(d.createdAt, tz)}</Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
