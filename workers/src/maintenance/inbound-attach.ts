import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@naaradh/db';
import { createServiceDb } from '@naaradh/db/service';
import { EngineRegistry, engineEnv, refineEngineEnv } from '@naaradh/engines-registry';
import { audit } from '@naaradh/pipeline';
import { isToolName, toolDefinitions } from '@naaradh/call-scripts';
import {
  baseEnv,
  createLogger,
  engineWebhookPath,
  inboundLookupPath,
  loadEnv,
  serviceDatabaseEnv,
  voiceToolPath,
} from '@naaradh/shared';

/**
 * `inbound-attach` — link one of OUR support-line numbers to its engine, for engines that
 * answer with a fixed agent per number (Bolna). Creates that agent with the tenant's tool URLs
 * and events URL, and points the engine's per-call caller lookup at our signed inbound URL for
 * this number. Runs once per number, from a trusted machine, after the number exists in the
 * engine's account and is assigned to a tenant with an active inbound profile in the console.
 *
 *   NUMBER_E164   one of our own numbers (never a customer's), as in the console's Numbers page
 *
 * Re-run it after changing the profile's enabled tools, locale or voice: the agent is rebuilt.
 */
const schemaEnv = z
  .object({
    ...baseEnv,
    ...serviceDatabaseEnv,
    ...engineEnv,
    NUMBER_E164: z.string().regex(/^\+[1-9]\d{7,14}$/),
    ENGINE_WEBHOOK_KEY: z.string().min(32),
    HOOKS_BASE_URL: z.string().url(),
    VOICE_BASE_URL: z.string().url(),
  })
  .superRefine(refineEngineEnv);

const env = loadEnv(schemaEnv, process.env);
const log = createLogger({ service: 'maintenance:inbound-attach', level: 'info' });
const service = createServiceDb({
  url: env.DATABASE_SERVICE_URL,
  applicationName: 'naaradh-inbound-attach',
});

try {
  const [number] = await service.db
    .select()
    .from(schema.numbers)
    .where(eq(schema.numbers.e164, env.NUMBER_E164))
    .limit(1);
  if (number === undefined) throw new Error('no such number — add it in the console first');
  if (number.tenantId === null || number.inboundProfileId === null || !number.inboundEnabled)
    throw new Error('the number needs a tenant, an inbound profile and inbound enabled (console)');
  const tenantId = number.tenantId;
  const [profile] = await service.db
    .select()
    .from(schema.inboundProfiles)
    .where(
      and(
        eq(schema.inboundProfiles.id, number.inboundProfileId),
        eq(schema.inboundProfiles.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (profile === undefined) throw new Error('the inbound profile does not exist');

  const adapter = new EngineRegistry({ env }).get(number.engine);
  const caps = adapter.capabilities();
  if (!caps.inbound || adapter.attachInboundNumber === undefined)
    throw new Error(`${number.engine} does not take inbound calls (or it is switched off)`);

  const tools = toolDefinitions({
    // Enabled-ness is enforced again on every tool call; a transfer needs an engine that can.
    tools: profile.toolsEnabled.filter(
      (t) => isToolName(t) && (t !== 'transfer_to_human' || caps.warmTransfer),
    ),
    locale: profile.locale,
    urlFor: (t) =>
      `${env.VOICE_BASE_URL}${voiceToolPath(env.ENGINE_WEBHOOK_KEY, number.engine, tenantId, t)}`,
  });
  const ref = await adapter.attachInboundNumber({
    e164: number.e164,
    inboundUrl: `${env.VOICE_BASE_URL}${inboundLookupPath(env.ENGINE_WEBHOOK_KEY, number.engine, number.e164)}`,
    agent: {
      name: `${tenantId}:inbound:${number.id}`,
      locale: profile.locale as 'hi-IN' | 'en-IN',
      // Filled per call from the admission decision (voice).
      systemPrompt: '',
      firstUtterance: '',
      voiceId: profile.voiceId ?? 'default',
      maxDurationSec: profile.maxDurationSec,
      tools,
      webhookUrl: `${env.HOOKS_BASE_URL}${engineWebhookPath(env.ENGINE_WEBHOOK_KEY, number.engine, tenantId)}`,
    },
  });
  await service.db.transaction((tx) =>
    audit(tx, {
      tenantId,
      actorType: 'system',
      actorId: 'maintenance:inbound-attach',
      action: 'number.inbound_attached',
      targetType: 'number',
      targetId: number.id,
      after: { engine: number.engine, agent_id: ref?.agentId ?? null, tools: tools.length },
    }),
  );
  log.info({ number_id: number.id, engine: number.engine, tools: tools.length }, 'attached');
  await service.close();
  process.exit(0);
} catch (error) {
  log.error({ err: error }, 'inbound-attach: failed');
  await service.close();
  process.exit(2);
}
