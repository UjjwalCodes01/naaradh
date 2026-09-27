import { REFERRAL_TERMS, referralSummary } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, Empty, Label, PageHeader, Table, Td, inputClass } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { claimReferralCode } from './actions';

const TONE = { claimed: 'neutral', qualified: 'good', rewarded: 'good', void: 'warning' } as const;

/** P7-GTM-1: your referral code, who you referred, and who referred you. */
export default async function Referrals() {
  const s = await requireSession('manager');
  const tz = (await tenantSettings()).timezone;
  const r = await inTenant(s, (tx) => referralSummary(tx, s.tenantId));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Referrals"
        description="Tell another store about Naaradh. When they join, they enter your code."
      />
      <Card title="Your referral code">
        <p className="font-mono text-2xl tracking-widest">{r.code}</p>
        <p className="mt-2 text-sm text-slate-600">
          A referral counts once the store has been paying for {REFERRAL_TERMS.qualifyAfterDays}{' '}
          days.{' '}
          {r.rewardActive
            ? 'You then receive a credit on your bill.'
            : 'Referral rewards are not switched on yet — every referral is recorded now and counts when they are.'}
        </p>
      </Card>

      <Card title="Stores you referred">
        {r.referred.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <Table head={['Store', 'Joined', 'Status', 'Credited']}>
            {r.referred.map((x) => (
              <tr key={`${x.name}-${x.claimedAt.toISOString()}`}>
                <Td>{x.name}</Td>
                <Td>{formatDate(x.claimedAt, tz)}</Td>
                <Td>
                  <Badge tone={TONE[x.status as keyof typeof TONE]}>{x.status}</Badge>
                </Td>
                <Td>{x.rewardedAt === null ? '—' : formatDate(x.rewardedAt, tz)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Were you referred?">
        {r.referredBy !== null ? (
          <p className="text-sm text-slate-700">
            Recorded on {formatDate(r.referredBy.claimedAt, tz)}. Thank you.
          </p>
        ) : s.role !== 'owner' ? (
          <p className="text-sm text-slate-600">An owner of this account can enter a code.</p>
        ) : (
          <ActionForm action={claimReferralCode} submit="Record referral">
            <Label htmlFor="code">Their referral code</Label>
            <input
              id="code"
              name="code"
              required
              maxLength={8}
              autoComplete="off"
              className={`${inputClass} uppercase`}
            />
            <p className="mt-1 text-xs text-slate-500">
              Within {REFERRAL_TERMS.claimWindowDays} days of joining, once. The store that referred
              you will see your business name.
            </p>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
