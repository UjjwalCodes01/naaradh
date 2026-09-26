/**
 * A new lead, as every CRM eventually describes one: someone asked to be called back.
 *
 * `lead_callback` is a **service** purpose (compliance/src/constants.ts), not a promotional one:
 * the person filled in a form asking for a call. So no consent row is required — but the gate
 * still applies in full, including suppressions, the calling window and the do-not-call list, and
 * a merchant who maps a consent field gets it recorded alongside.
 */

export const CRM_PROVIDERS = ['zoho', 'hubspot'] as const;

export type CrmProvider = (typeof CRM_PROVIDERS)[number];

export function isCrmProvider(value: string): value is CrmProvider {
  return (CRM_PROVIDERS as readonly string[]).includes(value);
}

export interface ParsedLead {
  readonly provider: CrmProvider;
  /**
   * The CRM's own record id. It is the idempotency key for the intent, so the same lead sent
   * twice (a retried workflow, a re-saved record) is one call, not two (E-52's rule, applied to
   * leads).
   */
  readonly externalId: string;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly email: string | null;
  readonly company: string | null;
  /** What the lead is about, read to the customer as the call's `topic` variable. */
  readonly topic: string | null;
  /** The form or campaign it came from, for the script and for the merchant's own reporting. */
  readonly formName: string | null;
  readonly countryCode: string | null;
  /** True only when the merchant mapped a field that says the person agreed to be called. */
  readonly consentGiven: boolean;
  readonly createdAt: Date | null;
}

export type LeadParseResult =
  | { readonly ok: true; readonly value: ParsedLead }
  | { readonly ok: false; readonly error: string };

/**
 * Per-integration field mapping (`integrations.metadata.crm.fields`). Both CRMs let a merchant
 * choose which fields a workflow webhook sends and what to call them, so the defaults below are a
 * starting point, not a contract — a merchant with a custom field says so once, here, instead of
 * asking us to ship code.
 */
export interface FieldMap {
  readonly phone?: readonly string[];
  readonly firstName?: readonly string[];
  readonly email?: readonly string[];
  readonly company?: readonly string[];
  readonly topic?: readonly string[];
  readonly formName?: readonly string[];
  readonly country?: readonly string[];
  readonly consent?: readonly string[];
  readonly id?: readonly string[];
}
