import { and, eq, sql } from 'drizzle-orm';
import { schema, type DbOrTx } from '@naaradh/db';
import {
  encryptPhone,
  hashPhone,
  maskPhone,
  newId,
  normalizePhone,
  dialRejectReason,
  sha256Hex,
  zoneHintForNumber,
  type ParsedPhone,
  type PhoneRegion,
} from '@naaradh/shared';

/**
 * Contacts are the only place a dialable number is written, and it is written encrypted
 * (invariant 8). Ingestion holds the PUBLIC key; nothing here can read a number back.
 */
export interface PhoneKeys {
  readonly hashKey: string;
  readonly encPublicKeyPem: string;
  readonly encKid: number;
}

export interface UpsertContactInput {
  readonly tenantId: string;
  readonly rawPhone: string;
  /** The merchant's country: used only to interpret a number with no country code. */
  readonly defaultRegion: PhoneRegion;
  readonly name?: string | null;
  readonly localeHint?: string | null;
  readonly timezone?: string | null;
  readonly source: string;
  readonly skip?: boolean;
  readonly at: Date;
}

export type UpsertContactResult =
  | { ok: true; contactId: string; phoneHash: string; phone: ParsedPhone; erased: boolean }
  | { ok: false; reason: 'invalid' | 'not_dialable'; detail: string; phoneHash: string | null };

export async function upsertContact(
  tx: DbOrTx,
  keys: PhoneKeys,
  input: UpsertContactInput,
): Promise<UpsertContactResult> {
  const parsed = normalizePhone(input.rawPhone, input.defaultRegion);
  if (!parsed.ok) return { ok: false, reason: 'invalid', detail: parsed.reason, phoneHash: null };
  const reject = dialRejectReason(parsed.phone);
  const phoneHash = hashPhone(parsed.phone.e164, keys.hashKey);
  if (reject !== null) return { ok: false, reason: 'not_dialable', detail: reject, phoneHash };

  const enc = encryptPhone(parsed.phone.e164, keys.encPublicKeyPem, keys.encKid);
  const id = newId('contact');
  const [row] = await tx
    .insert(schema.contacts)
    .values({
      id,
      tenantId: input.tenantId,
      phoneHash,
      phoneEnc: enc.ciphertext,
      phoneEncKid: enc.kid,
      phoneMasked: maskPhone(parsed.phone.e164),
      region: parsed.phone.region,
      phoneType: parsed.phone.type === 'unknown' ? 'unknown' : parsed.phone.type,
      phoneTypeCheckedAt: parsed.phone.type === 'unknown' ? null : input.at,
      name: input.name ?? null,
      localeHint: input.localeHint ?? null,
      // The shipping address knows best; failing that, the area code (Hawaii, Alaska, Atlantic Canada).
      timezone: input.timezone ?? zoneHintForNumber(parsed.phone),
      source: input.source,
      skip: input.skip ?? false,
    })
    .onConflictDoUpdate({
      target: [schema.contacts.tenantId, schema.contacts.phoneHash],
      // An erased contact stays erased: never re-populate name or number (E-10).
      set: {
        name: sql`case when ${schema.contacts.erasedAt} is null then coalesce(excluded.name, ${schema.contacts.name}) else null end`,
        timezone: sql`coalesce(excluded.timezone, ${schema.contacts.timezone})`,
        localeHint: sql`coalesce(excluded.locale_hint, ${schema.contacts.localeHint})`,
        phoneEnc: sql`case when ${schema.contacts.erasedAt} is null then coalesce(${schema.contacts.phoneEnc}, excluded.phone_enc) else null end`,
        phoneEncKid: sql`case when ${schema.contacts.erasedAt} is null then coalesce(${schema.contacts.phoneEncKid}, excluded.phone_enc_kid) else null end`,
        skip: sql`${schema.contacts.skip} or excluded.skip`,
      },
    })
    .returning({ id: schema.contacts.id, erasedAt: schema.contacts.erasedAt });
  if (row === undefined) throw new Error('contact upsert returned no row');
  return {
    ok: true,
    contactId: row.id,
    phoneHash,
    phone: parsed.phone,
    erased: row.erasedAt !== null,
  };
}

/**
 * A contact row for an order that had NO usable number, so the gated intent can still be
 * shown to the merchant (E-43). The hash is of a sentinel, not of a phone; there is nothing
 * to encrypt.
 */
export async function placeholderContact(
  tx: DbOrTx,
  keys: PhoneKeys,
  tenantId: string,
  sentinel: string,
  region: string,
): Promise<{ contactId: string; phoneHash: string }> {
  // Keyed so two environments never share a placeholder hash; sha256 (not HMAC-of-a-phone)
  // so it can never collide with a real contact's hash.
  const phoneHash = sha256Hex(`placeholder:${keys.hashKey}:${tenantId}:${sentinel}`);
  const id = newId('contact');
  const [row] = await tx
    .insert(schema.contacts)
    .values({
      id,
      tenantId,
      phoneHash,
      phoneEnc: null,
      phoneEncKid: null,
      phoneMasked: '—',
      region,
      phoneType: 'unknown',
      source: 'placeholder',
    })
    .onConflictDoUpdate({
      target: [schema.contacts.tenantId, schema.contacts.phoneHash],
      set: { updatedAt: sql`now()` },
    })
    .returning({ id: schema.contacts.id });
  if (row === undefined) throw new Error('placeholder contact returned no row');
  return { contactId: row.id, phoneHash };
}

export async function markContactSkip(
  tx: DbOrTx,
  tenantId: string,
  phoneHash: string,
  skip: boolean,
): Promise<void> {
  await tx
    .update(schema.contacts)
    .set({ skip })
    .where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.phoneHash, phoneHash)));
}
