import { getSsoSettings } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Label, PageHeader, inputClass } from '@/components/ui';
import { env } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { ssoKey, ssoRedirectUri } from '@/lib/sso';
import { tenantSettings } from '@/lib/tenant';
import { enforceSso, saveSso, switchSso } from './actions';

/**
 * P7-ENT-1: OpenID Connect single sign-on, owners only. Built so that nothing here can lock the
 * account out: it starts in testing, enforcement needs one real sign-in first, any change sends
 * it back to testing, and owners always keep the email link.
 */
export default async function SsoSettings() {
  const s = await requireSession('owner');
  const tz = (await tenantSettings()).timezone;
  const view = await inTenant(s, (tx) => getSsoSettings(tx, s.tenantId));
  const available = ssoKey() !== null;
  const link = view === null ? null : `${env().APP_URL}/auth/sso/start/${view.slug}`;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Single sign-on"
        description="Let your team sign in through Okta, Microsoft Entra ID, Google Workspace or any OpenID Connect provider."
      />
      {!available ? (
        <Card>
          <p className="text-sm text-slate-700">
            Single sign-on is not available on this deployment yet.
          </p>
        </Card>
      ) : (
        <>
          <Card title="1. Register Naaradh with your provider">
            <p className="text-sm text-slate-700">
              Create a web application (OpenID Connect, authorization code) and give it this
              redirect URI:
            </p>
            <code className="mt-2 block break-all rounded bg-slate-100 p-2 text-xs">
              {ssoRedirectUri()}
            </code>
            <p className="mt-2 text-xs text-slate-500">
              The ID token must carry <code>email</code> and <code>email_verified</code> (for
              Microsoft Entra ID, enable the <code>xms_edov</code> optional claim). Naaradh never
              trusts an email address the provider has not confirmed.
            </p>
          </Card>

          <Card title="2. Tell Naaradh about it">
            <ActionForm action={saveSso} submit={view === null ? 'Save' : 'Save changes'}>
              <div className="grid gap-3">
                <div>
                  <Label htmlFor="issuer">Issuer URL</Label>
                  <input
                    id="issuer"
                    name="issuer"
                    required
                    placeholder="https://your-company.okta.com"
                    defaultValue={view?.issuer ?? ''}
                    className={inputClass}
                  />
                </div>
                <div>
                  <Label htmlFor="client_id">Client ID</Label>
                  <input
                    id="client_id"
                    name="client_id"
                    required
                    defaultValue={view?.clientId ?? ''}
                    className={inputClass}
                  />
                </div>
                <div>
                  <Label htmlFor="client_secret">Client secret</Label>
                  <input
                    id="client_secret"
                    name="client_secret"
                    type="password"
                    autoComplete="off"
                    required={view === null}
                    placeholder={view === null ? '' : 'Stored — leave empty to keep it'}
                    className={inputClass}
                  />
                </div>
                <div>
                  <Label htmlFor="email_domains">Email domains</Label>
                  <input
                    id="email_domains"
                    name="email_domains"
                    required
                    placeholder="your-company.com"
                    defaultValue={view?.emailDomains.join(', ') ?? ''}
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Only these addresses can sign in this way, and only people you have already
                    invited. Single sign-on never creates users.
                  </p>
                </div>
              </div>
            </ActionForm>
          </Card>

          {view === null || link === null ? null : (
            <Card title="3. Share the sign-in link">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  tone={
                    view.status === 'active'
                      ? 'good'
                      : view.status === 'testing'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {view.status}
                </Badge>
                {view.enforced ? <Badge tone="good">required</Badge> : null}
                <span className="text-slate-500">
                  {view.lastSuccessAt === null
                    ? 'Nobody has signed in through it yet.'
                    : `Last sign-in ${formatDateTime(view.lastSuccessAt, tz)}.`}
                </span>
              </div>
              <code className="mt-3 block break-all rounded bg-slate-100 p-2 text-xs">{link}</code>
              <p className="mt-2 text-xs text-slate-500">
                Your team uses this link, or pastes the code at the end of it on the sign-in page.
                Sign in through it yourself first: that proves the setup and turns testing into
                active.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                {view.status === 'active' ? (
                  <ActionForm
                    action={enforceSso}
                    submit={view.enforced ? 'Allow email links again' : 'Require single sign-on'}
                  >
                    <input type="hidden" name="enforced" value={view.enforced ? 'false' : 'true'} />
                  </ActionForm>
                ) : null}
                <ActionForm
                  action={switchSso}
                  submit={view.status === 'disabled' ? 'Turn back on' : 'Turn off'}
                >
                  <input
                    type="hidden"
                    name="status"
                    value={view.status === 'disabled' ? 'testing' : 'disabled'}
                  />
                </ActionForm>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Requiring it stops email links for everyone in those domains except owners, who keep
                them as the way back in if your provider ever breaks.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
