import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import {
  accountBanner,
  getSettings,
  listProfiles,
  listScripts,
  listUseCases,
  overview,
  usageSummary,
} from '@naaradh/pipeline';
import { shopContext } from '../lib/context.server';
import { env } from '../lib/env.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await shopContext(request);
  const now = new Date();
  return ctx.inTenant(async (tx) => {
    const [t, useCases, scripts, profiles, ov, usage] = [
      await getSettings(tx, ctx.tenantId),
      await listUseCases(tx, ctx.tenantId),
      await listScripts(tx, ctx.tenantId),
      await listProfiles(tx, ctx.tenantId),
      await overview(tx, ctx.tenantId, now, 7),
      await usageSummary(tx, ctx.tenantId, now),
    ];
    const cod = useCases.find((u) => u.kind === 'cod_confirm');
    const banner = accountBanner({
      status: t.status,
      pausedReason: t.pausedReason,
      billingStatus: t.billingStatus,
      billingGraceUntil: t.billingGraceUntil,
      reviewUntil: t.reviewUntil,
    });
    return {
      name: t.name,
      waitlist: t.country !== 'IN',
      banner,
      steps: [
        {
          done: t.attestation !== null,
          label: 'Business details and compliance',
          href: '/app/setup',
        },
        {
          done: scripts.some((s) => s.status === 'approved' && s.useCase === 'cod_confirm'),
          label: 'Approve your COD confirmation script',
          href: '/app/scripts',
        },
        {
          done: usage.subscription?.status === 'active',
          label: 'Choose a plan',
          href: '/app/billing',
        },
        {
          done: profiles.some((p) => p.status === 'active'),
          label: 'Set up the support line (optional)',
          href: '/app/support',
        },
        { done: cod?.enabled === true, label: 'Go live with COD confirmation', href: '/app/setup' },
      ],
      week: ov,
      dashboardUrl: env().DASHBOARD_URL,
    };
  });
};

export default function Home() {
  const d = useLoaderData<typeof loader>();
  if (d.waitlist)
    return (
      <s-page heading="Naaradh">
        <s-section heading="Coming to your region">
          <s-paragraph>
            Naaradh currently calls customers in India only, from Indian numbers and under Indian
            telecom rules. We have saved your store and will email you when calling opens for your
            country. Nothing is charged until then.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  return (
    <s-page heading={`Naaradh · ${d.name}`}>
      {d.banner === null ? null : (
        <s-banner tone={d.banner.tone === 'bad' ? 'critical' : 'warning'} heading={d.banner.title}>
          {d.banner.body}
        </s-banner>
      )}
      <s-section heading="Get set up">
        <s-unordered-list>
          {d.steps.map((s) => (
            <s-list-item key={s.label}>
              {s.done ? '✓ ' : '○ '}
              <s-link href={s.href}>{s.label}</s-link>
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-section>
      <s-section heading="Last 7 days">
        <s-paragraph>
          {d.week.outbound.orders} COD orders received · {d.week.outbound.confirmed} confirmed ·{' '}
          {d.week.outbound.cancelledBeforeShip} cancelled before shipping · {d.week.outbound.gated}{' '}
          not called (see why in the dashboard)
        </s-paragraph>
        <s-paragraph>
          {d.week.inbound.calls} support calls · {d.week.inbound.resolvedByAgent} resolved by the
          agent · {d.week.ticketsOpen} open tickets
        </s-paragraph>
        <s-button href={`${d.dashboardUrl}/app`} target="_blank">
          Open the full dashboard
        </s-button>
      </s-section>
    </s-page>
  );
}
