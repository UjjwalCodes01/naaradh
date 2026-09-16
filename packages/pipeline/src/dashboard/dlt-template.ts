import { eq } from 'drizzle-orm';
import { schema, type Tx } from '@naaradh/db';
import { PROMOTIONAL_USE_CASES } from '@naaradh/compliance';
import { NaaradhError } from '@naaradh/shared';

/** A DLT content template id: the long numeric id the DLT portal issues. `[VERIFY]` length per TSP. */
export const DLT_TEMPLATE_ID = /^\d{12,25}$/;

/**
 * ADR-0010 §4: an Indian merchant's promotional script must carry the DLT content template id
 * its wording was registered under; the id is frozen with the script at approval. Returns the id
 * to store (null for scripts that need none), or throws.
 */
export async function requireDltTemplate(
  tx: Tx,
  tenantId: string,
  useCaseId: string,
  candidate: string | null | undefined,
  message = 'promotional scripts need the DLT content template ID this wording was registered under (12–25 digits)',
): Promise<string | null> {
  const id = candidate?.trim() || null;
  const [uc] = await tx
    .select({ kind: schema.useCases.kind })
    .from(schema.useCases)
    .where(eq(schema.useCases.id, useCaseId))
    .limit(1);
  const [t] = await tx
    .select({ country: schema.tenants.country })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  if (
    uc === undefined ||
    !(PROMOTIONAL_USE_CASES as readonly string[]).includes(uc.kind) ||
    t?.country !== 'IN'
  )
    return id;
  if (id === null || !DLT_TEMPLATE_ID.test(id))
    throw new NaaradhError('VALIDATION_FAILED', message);
  return id;
}
