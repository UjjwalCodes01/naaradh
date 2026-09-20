export { audit, scrub, type AuditInput, type ActorType } from './audit.js';
export {
  emitMerchantEvent,
  EMAIL_ALERT_EVENTS,
  MERCHANT_EVENTS,
  type MerchantEvent,
  type MerchantEventType,
} from './outbox.js';
export {
  upsertContact,
  placeholderContact,
  markContactSkip,
  type PhoneKeys,
  type UpsertContactInput,
  type UpsertContactResult,
} from './contacts.js';
export {
  createIntent,
  idempotencyKeyFor,
  pilotBucket,
  UseCaseConfig,
  type CreateIntentInput,
  type CreateIntentResult,
} from './intents.js';
export { cancelIntents, type CancelResult } from './cancel.js';

// Inbound (ADR-0006)
export {
  upsertOrder,
  applyTracking,
  markOrderCancelled,
  eraseOrders,
  ordersForCaller,
  countOrdersForCaller,
  orderByRef,
  ordersByIds,
  toOrderView,
  hashPincode,
  pincodeMatches,
  type OrderUpsert,
  type OrderRow,
  type OrderView,
  type Tracking,
  type OrderSource,
  type PaymentKind,
} from './inbound/orders.js';
export { searchKnowledge, toTsQuery, snippet, type KnowledgeHit } from './inbound/knowledge.js';
export {
  createTicket,
  cleanSummary,
  ticketPriority,
  type CreateTicketInput,
  type TicketCategory,
} from './inbound/tickets.js';
export {
  recordAgentAction,
  newConfirmToken,
  hashConfirmToken,
  findConfirmation,
  findToolReplay,
  scrubArgs,
  type RecordActionInput,
  type AgentActionStatus,
} from './inbound/agent-actions.js';
export {
  verifyCaller,
  effectiveIdentity,
  type AttemptIdentity,
  type VerifyResult,
} from './inbound/identity.js';
export {
  INBOUND_PLANS,
  inboundPlanFor,
  billedMinutes,
  inboundMinutesUsed,
  meterInboundCall,
  type InboundPlan,
  type MeterResult,
} from './inbound/billing.js';
export {
  subjectMedia,
  eraseSubject,
  mediaDueForRetention,
  markMediaPurged,
  eraseOrdersPlacedBefore,
  type SubjectMedia,
  type ErasureCounts,
  type MediaDue,
} from './privacy.js';
export {
  PLANS,
  effectivePlan,
  planTenantOf,
  billingCurrencyOf,
  formatMinor,
  type Plan,
  type PlanKind,
  type PlanPrice,
  type BillingCurrency,
  type EffectivePlan,
  type PlanTenant,
} from './billing/plans.js';
export { meterOutcome, type OutcomeMeter } from './billing/meter.js';
export {
  applySubscriptionState,
  markTenantCapped,
  fromShopifyStatus,
  fromRazorpayStatus,
  fromStripeStatus,
  BILLING_GRACE_DAYS,
  type SubscriptionStatus,
  type TenantBillingStatus,
  type FetchedSubscription,
  type BillingTransition,
} from './billing/subscriptions.js';
export {
  createPostings,
  claimPostings,
  settlePosting,
  postedTotal,
  providerAmount,
  type PostingsCreated,
  type ClaimedPosting,
} from './billing/postings.js';
export { openDispute, resolveDispute, DISPUTE_WINDOW_DAYS } from './billing/disputes.js';
export { usageSummary, type UsageSummary, type DirectionUsage } from './billing/usage.js';

// Admin operations shared by the API and the dashboards (ADR-0009)
export { actorLabel, auditActor, type Actor } from './admin/actor.js';
export {
  ATTESTATION_STATEMENT,
  AttestationInput,
  KnowledgeInput,
  ProfileInput,
  StaffPhoneInput,
  TransferTargetInput,
  createArticle,
  createProfile,
  createTransferTarget,
  deactivateTransferTarget,
  describeErrors,
  getProfile,
  listArticles,
  listProfiles,
  listTickets,
  listTransferTargets,
  profileView,
  resolveTicket,
  setProfileStatus,
  startTicket,
  updateArticle,
  updateProfile,
  verifyTransferTarget,
  type ArticleView,
  type ProfileView,
  type StaffKeys,
  type TicketStatus,
  type TransferTargetView,
} from './admin/support.js';
export {
  DIRECT_USE_CASES,
  DirectTenantInput,
  DltLinkInput,
  NUMBER_SERIES,
  NUMBER_STATUSES,
  NumberAssignInput,
  NumberInput,
  NumberPurposesInput,
  NumberStatusInput,
  NumberAttestationInput,
  PURPOSES,
  assignNumber,
  createDirectTenant,
  listNumbers,
  pendingDltLinks,
  registerNumber,
  setDltLink,
  setNumberPurposes,
  setNumberStatus,
  setNumberAttestation,
  type DirectTenantResult,
  type NumberSeries,
  type NumberStatus,
  type NumberView,
  type Purpose,
  type StaffActor,
} from './admin/staff.js';

// Merchant dashboards (ADR-0009)
export {
  Email,
  LOGIN_TOKEN_TTL_MIN,
  SESSION_ABSOLUTE_DAYS,
  SESSION_IDLE_SECONDS,
  consumeLoginToken,
  issueLoginLinks,
  resolveWebSession,
  type LoginLink,
  type OpenedSession,
  type WebRole,
  type WebSession,
} from './web-auth.js';
export {
  explainAgentAction,
  explainCheckout,
  explainGate,
  explainIdentity,
  explainIntentStatus,
  explainOutcome,
  explainWriteback,
  type Explained,
} from './dashboard/explain.js';
export {
  PAGE_SIZE,
  accessMedia,
  decodeCursor,
  encodeCursor,
  inboundDetail,
  listInbound,
  listOutbound,
  outboundDetail,
  type AgentActionView,
  type AttemptView,
  type GateStepView,
  type InboundDetail,
  type InboundRow,
  type OutboundDetail,
  type OutboundFilter,
  type OutboundRow,
  type OutcomeView,
} from './dashboard/calls.js';
export {
  accountBanner,
  overview,
  type AccountBanner,
  type Overview,
} from './dashboard/overview.js';
export {
  InviteInput,
  ROLES,
  changeRole,
  disableUser,
  inviteUser,
  listSessions,
  listUsers,
  requireRole,
  revokeSessions,
  roleAtLeast,
  type Role,
  type SessionView,
  type UserView,
} from './dashboard/team.js';
export {
  NotificationSettings,
  SettingsInput,
  getSettings,
  listUseCases,
  notificationSettingsOf,
  roiSettingsOf,
  setUseCaseEnabled,
  updateSettings,
  type TenantSettingsView,
  type UseCaseView,
} from './dashboard/settings.js';
export { approveScript, listScripts, type ScriptView } from './dashboard/scripts.js';
export { DLT_TEMPLATE_ID, requireDltTemplate } from './dashboard/dlt-template.js';
export {
  abTestMetrics,
  endAbTest,
  isAbTestRunning,
  startAbTest,
  twoProportionPValue,
  type AbTestView,
  type ArmMetrics,
} from './dashboard/ab.js';
export { recoveryReport, type MoneyByCurrency, type RecoveryReport } from './dashboard/recovery.js';

// Promotional calling (ADR-0010)
export {
  CONSENT_WORDINGS,
  CURRENT_CONSENT_WORDING,
  isKnownConsentWording,
  type ConsentWording,
} from './promotional/consent-wording.js';
export {
  CHECKOUT_OPEN_STATUSES,
  convertCheckouts,
  inRegion,
  intentSourceFor,
  eraseCheckouts,
  recordCheckout,
  recordOrderConsent,
  sweepAbandonedCheckouts,
  type CheckoutInput,
  type CheckoutSource,
  type DataRegion,
  type RecordCheckoutResult,
  type SweepReport,
} from './promotional/checkouts.js';
export {
  attributeOrder,
  attributionWindowHours,
  reverseAttribution,
  type AttributeOrderInput,
  type AttributionResult,
} from './promotional/attribution.js';
export { createFeedbackIntent, type FeedbackResult } from './promotional/feedback.js';

// Appointments (ADR-0011)
export {
  CalendarInput,
  createCalendar,
  listCalendars,
  setCalendarStatus,
  upcomingAppointments,
  type CalendarView,
  type UpcomingAppointment,
} from './admin/calendars.js';
export {
  eraseAppointments,
  sweepAppointmentReminders,
  upsertAppointment,
  type AppointmentInput,
  type AppointmentResult,
  type AppointmentStatus,
  type ReminderReport,
} from './appointments/store.js';
export {
  QA_RUBRIC,
  QaReviewInput,
  isoWeekOf,
  listQaQueue,
  qaAccuracy,
  qaSampleKey,
  qaSampleSize,
  sampleWeeklyQa,
  submitQaReview,
  type QaAccuracyRow,
  type QaQueueRow,
  type QaSampleReport,
} from './admin/qa.js';
export {
  addSuppression,
  checkNumber,
  fileErasureRequest,
  liftSuppression,
  listComplaints,
  listErasureRequests,
  listSuppressions,
  type SuppressionView,
} from './dashboard/privacy.js';
export {
  API_SCOPES,
  ApiKeyInput,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  webhookHealth,
  type ApiKeyView,
} from './dashboard/developers.js';
export { ACCESS_ACTIONS, listActivity, type ActivityRow } from './dashboard/activity.js';
export {
  dataRegionFor,
  deleteShopifySessions,
  loadShopifySession,
  provisionShopifyInstall,
  shopifySessionsForShop,
  storeShopifySession,
  textArray,
  type InstallInput,
  type InstallResult,
  type StoredShopifySession,
  type TokenKey,
} from './shopify-install.js';
export { DNC_CONFIRMATION, ipHashOf, submitDncRequest, type CounterStore } from './public-dnc.js';
export {
  SubscribeInput,
  listDisputes,
  planKey,
  razorpayPlanFor,
  recordRazorpaySubscription,
  assertBilledDirectly,
} from './billing/razorpay-subscribe.js';
export {
  STRIPE_CURRENCIES,
  StripeCheckoutInput,
  stripePricesFor,
  recordStripeCheckout,
  attachStripeSubscription,
  type StripeCurrency,
} from './billing/stripe-subscribe.js';
export {
  ATTESTATION_VERSION,
  MERCHANT_ATTESTATION,
  attestationOf,
  recordAttestation,
  recordShopifySubscription,
  shopifySubscriptionTerms,
  type ShopifySubscriptionTerms,
} from './billing/shopify-subscribe.js';
export { ensureDefaultSetup, setupLocaleFor, type SetupLocale } from './dashboard/setup.js';
// Key rotation jobs (docs/runbooks/secret-rotation.md)
export {
  CUSTOMER_PHONE_COLUMNS,
  KEY_ROTATED_ACTION,
  ROTATION_BATCH,
  STAFF_PHONE_COLUMNS,
  rotateEncryptedPhoneColumn,
  rotateShopifySessions,
  type EncryptedPhoneColumn,
  type PhoneKeyRotation,
  type RotationCounts,
  type RotationOptions,
} from './rotation.js';
export {
  loadDncRegistry,
  dncRegistryStatus,
  parseRegistryLine,
  type DncListSpec,
  type DncLoadResult,
} from './dnc/registry.js';
export {
  DATA_REGIONS,
  DirectoryEntry,
  DirectorySnapshot,
  applyDirectorySnapshot,
  localDirectoryEntries,
  lookupRegion,
  type DirectoryApplied,
} from './region/directory.js';
