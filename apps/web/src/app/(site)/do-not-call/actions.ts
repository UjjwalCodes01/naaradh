'use server';

import { DNC_REQUESTS_PER_IP_PER_HOUR } from '@naaradh/compliance';
import { DNC_CONFIRMATION, submitDncRequest } from '@naaradh/pipeline';
import { field, run, type ActionResult } from '@/lib/actions';
import { env } from '@/lib/env';
import { clientIp } from '@/lib/request';
import { allow } from '@/lib/rate-limit';
import { db, now, redis } from '@/lib/server';

/** Universal rule 8: anyone can stop all calls from businesses using Naaradh. */
export async function requestDoNotCall(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const ip = await clientIp();
    if (!(await allow(`dnc:${ip}`, DNC_REQUESTS_PER_IP_PER_HOUR, 3600, { failClosed: true })))
      return {
        ok: false,
        message: 'Too many requests from this network. Please try again in an hour.',
      };
    await submitDncRequest(db(), redis(), {
      hashKey: env().PHONE_HASH_KEY,
      phone: field(form, 'phone'),
      region: field(form, 'region') || 'IN',
      reportUnwantedCall: form.get('report') === 'on',
      ip,
      now: now(),
    });
    return DNC_CONFIRMATION;
  });
}
