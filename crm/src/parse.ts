/**
 * Reading a lead out of a CRM's webhook body.
 *
 * Neither CRM has one payload. **Zoho**'s Notifications API sends only record ids (fetching the
 * record needs OAuth), so the path a merchant can actually configure today is a **workflow
 * webhook**, where they choose the fields and the parameter names. **HubSpot** is the same story:
 * a workflow webhook posts the properties the merchant selected, sometimes flat, sometimes under
 * `properties`, sometimes with each property as `{ value }`.
 *
 * So this reads a flat-ish object by *name*, with the field names each CRM uses by default and a
 * per-merchant override (`integrations.metadata.crm.fields`) for anything custom. It is
 * deliberately forgiving about shape and strict about one thing: it never guesses a phone number.
 * A lead with no readable phone is an error the merchant can see and fix, not a silent drop.
 */
import { z } from 'zod';
import type { CrmProvider, FieldMap, LeadParseResult } from './types.js';

/** Default names, longest-standing first. Zoho's are Capitalised_With_Underscores, HubSpot's lower. */
const DEFAULTS: Readonly<Record<CrmProvider, Required<FieldMap>>> = {
  zoho: {
    id: ['id', 'Id', 'ID', 'Lead_Id', 'record_id', 'entity_id'],
    phone: ['Phone', 'Mobile', 'phone', 'mobile', 'Phone_Number'],
    firstName: ['First_Name', 'Full_Name', 'Last_Name', 'first_name', 'Name'],
    email: ['Email', 'email', 'Secondary_Email'],
    company: ['Company', 'Account_Name', 'company'],
    topic: ['Description', 'Lead_Status', 'Subject', 'description'],
    formName: ['Lead_Source', 'Campaign_Source', 'lead_source'],
    country: ['Country', 'Mailing_Country', 'country'],
    consent: ['Consent', 'Data_Processing_Basis', 'consent'],
  },
  hubspot: {
    id: ['objectId', 'vid', 'id', 'hs_object_id', 'contactId'],
    phone: ['phone', 'mobilephone', 'hs_whatsapp_phone_number', 'Phone'],
    firstName: ['firstname', 'first_name', 'fullname', 'lastname'],
    email: ['email', 'work_email'],
    company: ['company', 'associatedcompanyid'],
    topic: ['message', 'what_can_we_help_you_with_', 'description', 'notes'],
    formName: ['hs_analytics_source', 'form_name', 'hs_latest_source', 'lifecyclestage'],
    country: ['country', 'ip_country_code', 'hs_country_region_code'],
    consent: ['hs_marketable_status', 'consent', 'communication_consent'],
  },
};

/** HubSpot sends `{ properties: { phone: { value: '…' } } }`; Zoho sends plain values. */
const Cell = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional() }),
]);

const Body = z.record(z.unknown());

function flatten(raw: unknown): Record<string, unknown> {
  const outer = Body.safeParse(raw);
  if (!outer.success) return {};
  const body = outer.data;
  const nested = ['properties', 'data', 'payload', 'lead', 'record', 'object'].reduce<
    Record<string, unknown>
  >((acc, key) => {
    const value = body[key];
    const parsed = Body.safeParse(value);
    return parsed.success ? { ...acc, ...parsed.data } : acc;
  }, {});
  // The outer object wins on a clash: a top-level `phone` is what the merchant mapped.
  return { ...nested, ...body };
}

function cell(value: unknown): string | null {
  const parsed = Cell.safeParse(value);
  if (!parsed.success) return null;
  const inner =
    typeof parsed.data === 'object' && parsed.data !== null ? parsed.data.value : parsed.data;
  if (inner === null || inner === undefined || typeof inner === 'object') return null;
  const text = String(inner).trim();
  return text.length === 0 ? null : text;
}

/** First mapped name that carries a value; the merchant's names are tried before the defaults. */
function pick(
  body: Record<string, unknown>,
  custom: readonly string[] | undefined,
  fallback: readonly string[],
): string | null {
  for (const name of [...(custom ?? []), ...fallback]) {
    const direct = cell(body[name]);
    if (direct !== null) return direct;
  }
  // Case-insensitive second pass: `Phone` vs `phone` is not worth a support ticket.
  const lower = new Map(Object.keys(body).map((k) => [k.toLowerCase(), k]));
  for (const name of [...(custom ?? []), ...fallback]) {
    const key = lower.get(name.toLowerCase());
    if (key !== undefined) {
      const value = cell(body[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

const TRUTHY = new Set(['true', 'yes', 'y', '1', 'on', 'granted', 'subscribed', 'opted_in']);

export function parseLead(
  provider: CrmProvider,
  raw: unknown,
  fields: FieldMap | undefined,
  receivedAt: Date,
): LeadParseResult {
  const body = flatten(raw);
  if (Object.keys(body).length === 0) return { ok: false, error: 'body: not an object' };
  const d = DEFAULTS[provider];

  const phone = pick(body, fields?.phone, d.phone);
  if (phone === null)
    return {
      ok: false,
      error: `phone: none of ${[...(fields?.phone ?? []), ...d.phone].slice(0, 4).join(', ')} is present — map the field in Settings if yours is named differently`,
    };

  const externalId = pick(body, fields?.id, d.id);
  const consent = pick(body, fields?.consent, d.consent);
  const created = pick(body, undefined, ['createdAt', 'created_at', 'Created_Time', 'occurredAt']);
  const createdAt = created === null ? null : toDate(created, receivedAt);

  return {
    ok: true,
    value: {
      provider,
      // No id from the CRM: the phone is what makes two deliveries the same lead, and
      // `createIntent` merges open intents for one number anyway (E-42).
      externalId: externalId ?? `lead:${phone}`,
      phone,
      firstName: pick(body, fields?.firstName, d.firstName),
      email: pick(body, fields?.email, d.email),
      company: pick(body, fields?.company, d.company),
      topic: pick(body, fields?.topic, d.topic),
      formName: pick(body, fields?.formName, d.formName),
      countryCode: countryOf(pick(body, fields?.country, d.country)),
      consentGiven: consent !== null && TRUTHY.has(consent.toLowerCase()),
      createdAt,
    },
  };
}

function toDate(value: string, fallback: Date): Date {
  const numeric = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const d = Number.isFinite(numeric)
    ? new Date(numeric > 1e11 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** Only a two-letter code is usable as a dialling region; a country *name* is not. */
function countryOf(value: string | null): string | null {
  return value !== null && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}
