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
  setUseCaseEnabled,
  updateSettings,
  type TenantSettingsView,
  type UseCaseView,
} from './dashboard/settings.js';
export { approveScript, listScripts, type ScriptView } from './dashboard/scripts.js';
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
} from './billing/razorpay-subscribe.js';
export {
  ATTESTATION_VERSION,
  MERCHANT_ATTESTATION,
  attestationOf,
  recordAttestation,
  recordShopifySubscription,
  shopifySubscriptionTerms,
  type ShopifySubscriptionTerms,
} from './billing/shopify-subscribe.js';
export { ensureDefaultSetup } from './dashboard/setup.js';
