/**
 * CRM lead sources behind one port (P5-CRM-1 Zoho, P5-CRM-2 HubSpot).
 *
 * A new lead in the merchant's CRM becomes a `lead_callback` intent through the same
 * `createIntent()` the public API uses — so the use case must be enabled, the number is
 * normalised and hashed, duplicates are merged, and the compliance gate decides whether and when
 * the call goes out. This package only authenticates the request and reads the lead out of it.
 */
export {
  CRM_PROVIDERS,
  isCrmProvider,
  type CrmProvider,
  type FieldMap,
  type LeadParseResult,
  type ParsedLead,
} from './types.js';
export { parseLead } from './parse.js';
export {
  CRM_SIGNATURE_HEADER,
  crmSharedSecret,
  crmWebhookPath,
  crmWebhookTag,
  verifyCrmSignature,
  verifyCrmTag,
  type CrmSignatureVerdict,
} from './verify.js';
