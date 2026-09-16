/**
 * THE gate (AGENTS.md §3). Every outbound call passes through `gateIntent()` before
 * `engine.placeCall()` — no code path may dial directly (invariant 1).
 *
 * Pure core (this package's `gate/`, `consent.ts`, `billable.ts`, `retry.ts`) + adapters
 * (`adapters/`) that implement the ports against Postgres and Redis. The regression suite in
 * test/regression runs the core against in-memory fakes with a fixed clock.
 */

export * from './constants.js';

export { gateIntent } from './gate/index.js';
export { GATE_REASONS, reasonInfo, type GateReason, type GateReasonInfo } from './gate/reasons.js';
export { windowFor, isOpen, closesAt, nextOpen, type RecipientWindow } from './gate/windows.js';
export type * from './gate/types.js';
export * from './adapters/index.js';
export {
  recordConsent,
  revokeConsent,
  suppress,
  liftSuppression,
  defaultSuppressionDays,
  recordComplaint,
  liftPromotionalPause,
  type RecordConsentInput,
  type RevokeConsentInput,
  type SuppressInput,
  type RecordComplaintInput,
  type ComplaintOutcome,
} from './ledger.js';

export {
  consentRequirement,
  consentRulesFor,
  isSourceAcceptable,
  consentExpiresAt,
  type ConsentRequirement,
} from './consent.js';
export {
  isBillable,
  type BillableInput,
  type BillableVerdict,
  type NotBillableReason,
  type BillableOutcome,
} from './billable.js';
export {
  isRetryEligible,
  nextRetryAt,
  RETRY_ELIGIBLE,
  NEVER_RETRY,
  type NextRetryInput,
} from './retry.js';

export {
  attributeComplaint,
  processComplaintReport,
  resolveComplaint,
  resumeTenant,
  type Attribution,
  type ProcessedReport,
} from './complaints.js';

// Inbound (ADR-0006)
export {
  admitInbound,
  inboundConcurrencyKey,
  INBOUND_REASONS,
  type AdmissionInput,
  type AdmissionDeps,
  type AdmissionResult,
  type AdmissionStep,
  type AdmissionNumber,
  type AdmissionTenant,
  type AdmissionProfile,
  type InboundReason,
  type Fallback,
} from './inbound/admission.js';
export {
  canDiscussOrder,
  cancellationPolicy,
  transferPolicy,
  isWithinHours,
  describeHours,
  isShipped,
  maxIdentity,
  orderNameKey,
  normalisePincode,
  IDENTITY_RANK,
  BusinessHours,
  type Identity,
  type OrderFacts,
  type CallerState,
  type CancellationDecision,
  type TransferDecision,
  type TransferTargetFacts,
} from './inbound/policy.js';
