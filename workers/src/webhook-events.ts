import { eq } from 'drizzle-orm';
import { schema, type Db } from '@naaradh/db';

/** Consumers load the stored payload by id (service role) and close the row when done. */
export async function loadWebhookEvent(service: Db, id: string) {
  const [row] = await service
    .select({
      id: schema.webhookEvents.id,
      source: schema.webhookEvents.source,
      topic: schema.webhookEvents.topic,
      tenantId: schema.webhookEvents.tenantId,
      externalAccount: schema.webhookEvents.externalAccount,
      status: schema.webhookEvents.status,
      signatureValid: schema.webhookEvents.signatureValid,
      payload: schema.webhookEvents.payload,
      receivedAt: schema.webhookEvents.receivedAt,
    })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, id))
    .limit(1);
  return row ?? null;
}

export async function markWebhookProcessed(
  service: Db,
  id: string,
  note: string | null = null,
): Promise<void> {
  await service
    .update(schema.webhookEvents)
    .set({ status: 'processed', processedAt: new Date(), error: note })
    .where(eq(schema.webhookEvents.id, id));
}

export async function markWebhookFailed(service: Db, id: string, error: string): Promise<void> {
  await service
    .update(schema.webhookEvents)
    .set({ status: 'failed', error: error.slice(0, 500) })
    .where(eq(schema.webhookEvents.id, id));
}
