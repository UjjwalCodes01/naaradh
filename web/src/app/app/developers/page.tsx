import {
  API_SCOPES,
  listApiKeys,
  listProviderIntegrations,
  providerCredentials,
  webhookHealth,
} from '@naaradh/pipeline';
import { CRM_PROVIDERS } from '@naaradh/crm';
import { OCC_PROVIDERS, effectiveSignaturePolicy } from '@naaradh/occ';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Empty, PageHeader, Table, Td, inputClass } from '@/components/ui';
import { formatDateTime, humanise } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { env } from '@/lib/env';
import { connectProvider, createKey, disconnectProvider, revokeKey } from './actions';

/** What each provider calls itself, for a panel a merchant reads beside their own dashboard. */
const PROVIDER_LABELS: Record<
  (typeof OCC_PROVIDERS)[number] | (typeof CRM_PROVIDERS)[number],
  string
> = {
  gokwik: 'GoKwik',
  shiprocket: 'Shiprocket Checkout',
  razorpay_magic: 'Razorpay Magic Checkout',
  cashfree: 'Cashfree One Click Checkout',
  zoho: 'Zoho CRM',
  hubspot: 'HubSpot',
};

export default async function Developers() {
  const s = await requireSession('owner');
  const tz = (await tenantSettings()).timezone;
  const [keys, hooks, providers] = await inTenant(
    s,
    async (tx) =>
      [
        await listApiKeys(tx, s.tenantId),
        await webhookHealth(tx, s.tenantId),
        await listProviderIntegrations(tx, s.tenantId),
      ] as const,
  );
  const providerKey = env().PROVIDER_WEBHOOK_KEY;
  const hooksBase = env().HOOKS_BASE_URL;
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
      {providerKey === undefined ? null : (
        <Card title="Connected providers">
          <p className="text-sm text-body">
            Two things can send us work directly. A <strong>one-click checkout</strong> (GoKwik,
            Shiprocket, Razorpay Magic, Cashfree) sends abandoned carts, because once your checkout
            is not Shopify&apos;s, Shopify stops telling us about them. A <strong>CRM</strong>
            (Zoho, HubSpot) sends new leads, which become callbacks. Turn one on, then paste the URL
            and secret below into their dashboard.
          </p>
          <p className="mt-2 text-sm text-body">
            Nothing changes about the rules: a cart still needs the customer&apos;s consent before a
            recovery call, and a callback still goes through the same checks as every other call.
          </p>
          <div className="mt-4">
            <ActionForm action={connectProvider} submit="Connect">
              <div className="grid gap-3 sm:grid-cols-3">
                <select name="provider" defaultValue="gokwik" className={inputClass}>
                  <optgroup label="One-click checkout">
                    {OCC_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="CRM">
                    {CRM_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <input
                  name="account_ref"
                  maxLength={120}
                  placeholder="Your account id there (optional)"
                  className={inputClass}
                />
                <select name="signature" defaultValue="default" className={inputClass}>
                  <option value="default">Use the provider&apos;s own scheme (recommended)</option>
                  <option value="required">Always require a signed webhook</option>
                  <option value="optional">Accept unsigned, where they do not sign</option>
                </select>
              </div>
            </ActionForm>
          </div>
          {providers.length === 0 ? (
            <div className="mt-4">
              <Empty>Nothing connected.</Empty>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              {providers.map((integration) => {
                const credentials = providerCredentials(
                  providerKey,
                  hooksBase,
                  integration.area,
                  integration.provider,
                  s.tenantId,
                );
                const live = integration.status === 'active';
                const signed =
                  integration.area === 'occ'
                    ? effectiveSignaturePolicy(
                        integration.provider as (typeof OCC_PROVIDERS)[number],
                        integration.signaturePolicy,
                      ) === 'required'
                    : integration.signaturePolicy === 'required';
                return (
                  <div key={integration.id} className="rounded-md border border-line p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-ink">
                        {PROVIDER_LABELS[integration.provider]}
                        <span className="ml-2 text-xs font-normal text-muted">
                          {integration.area === 'occ' ? 'abandoned carts' : 'new leads'}
                        </span>
                      </div>
                      <Badge tone={live ? 'good' : 'bad'}>{live ? 'On' : 'Off'}</Badge>
                    </div>
                    {live ? (
                      <dl className="mt-3 space-y-2 text-xs">
                        <div>
                          <dt className="text-muted">Webhook URL</dt>
                          <dd className="break-all font-mono text-ink">{credentials.url}</dd>
                        </div>
                        <div>
                          <dt className="text-muted">
                            Signing secret
                            {signed
                              ? ' (required — an unsigned delivery is refused)'
                              : ' (used only if they sign)'}
                          </dt>
                          <dd className="break-all font-mono text-ink">{credentials.secret}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="mt-2 text-xs text-muted">
                        What this provider sends is recorded but not acted on. Connect it again
                        above to resume.
                      </p>
                    )}
                    {live ? (
                      <div className="mt-3">
                        <ActionForm action={disconnectProvider} submit="Turn off">
                          <input type="hidden" name="provider" value={integration.provider} />
                        </ActionForm>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Treat the URL like a password: anyone who has it can send us carts or leads for your
            shop. If it leaks, tell us — rotating the key re-issues every merchant&apos;s URL.
          </p>
        </Card>
      )}
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
