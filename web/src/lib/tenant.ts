import { cache } from 'react';
import { getSettings, type TenantSettingsView } from '@naaradh/pipeline';
import { inTenant, requireSession } from './session';

/** The signed-in tenant's settings, once per request (time zone for display, banner state). */
export const tenantSettings = cache(async (): Promise<TenantSettingsView> => {
  const s = await requireSession();
  return inTenant(s, (tx) => getSettings(tx, s.tenantId));
});
