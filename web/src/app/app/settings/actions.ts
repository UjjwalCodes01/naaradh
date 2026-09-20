'use server';

import { revalidatePath } from 'next/cache';
import { SettingsInput, setUseCaseEnabled, updateSettings } from '@naaradh/pipeline';
import { checkbox, field, optionalField, run, type ActionResult } from '@/lib/actions';
import { actorOf, inTenant, requireSession } from '@/lib/session';

const rupeesToPaise = (v: string | null) => (v === null ? null : Math.round(Number(v) * 100));

export async function saveSettings(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const input = SettingsInput.parse({
      name: field(form, 'name'),
      legal_name: optionalField(form, 'legal_name'),
      timezone: field(form, 'timezone'),
      gstin: optionalField(form, 'gstin'),
      pan: optionalField(form, 'pan'),
      dlt_pe_id: optionalField(form, 'dlt_pe_id'),
      spend_cap_daily_paise: rupeesToPaise(optionalField(form, 'spend_cap_daily')),
      spend_cap_monthly_paise: rupeesToPaise(optionalField(form, 'spend_cap_monthly')),
      retention_days: Number(field(form, 'retention_days')),
      amd_mode_transactional: field(form, 'amd_mode_transactional'),
      amd_mode_promotional: field(form, 'amd_mode_promotional'),
      auto_cancel_enabled: checkbox(form, 'auto_cancel_enabled'),
      shopify_sync_optout: checkbox(form, 'shopify_sync_optout'),
      notifications: {
        daily_summary: checkbox(form, 'daily_summary'),
        gated_digest: checkbox(form, 'gated_digest'),
      },
      rto_cost_paise: rupeesToPaise(optionalField(form, 'rto_cost')),
      attribution_hours: Number(field(form, 'attribution_hours') || '24'),
    });
    await inTenant(s, (tx) => updateSettings(tx, actorOf(s), s.role, input));
    revalidatePath('/app', 'layout');
    return 'Saved.';
  });
}

export async function toggleUseCase(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('manager');
    const enabled = field(form, 'enabled') === 'true';
    await inTenant(s, (tx) =>
      setUseCaseEnabled(tx, actorOf(s), s.role, field(form, 'id'), enabled),
    );
    revalidatePath('/app/settings');
    return enabled ? 'Turned on.' : 'Turned off.';
  });
}
