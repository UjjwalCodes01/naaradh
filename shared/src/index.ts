export { ID_PREFIXES, newId, isId, parseId, type IdKind, type PrefixedId } from './ids.js';

export {
  ERROR_CODES,
  NaaradhError,
  GatedError,
  SignatureInvalidError,
  IdempotentReplayError,
  isNaaradhError,
  type ErrorCode,
  type NaaradhErrorOptions,
} from './errors.js';

export {
  REDACT_PATHS,
  createLogger,
  fastifyLoggerOptions,
  type Logger,
  type LoggerBindings,
  type CreateLoggerOptions,
} from './logger.js';

export {
  INDIAN_MOBILE,
  normalizePhone,
  zoneHintForNumber,
  dialRejectReason,
  isDialable,
  hashPhone,
  maskPhone,
  encryptPhone,
  decryptPhone,
  generatePhoneKeyPair,
  type ParsedPhone,
  type PhoneRegion,
  type PhoneRejectReason,
  type NormalizeResult,
  type EncryptedPhone,
} from './phone.js';

export {
  sha256Hex,
  timingSafeEqualString,
  WEBHOOK_REPLAY_WINDOW_SEC,
  signMerchantWebhook,
  verifyMerchantWebhook,
  inboundLookupPath,
  verifyInboundLookup,
  generateRegionKeyPair,
  signRegionSnapshot,
  verifyRegionSnapshot,
  verifyShopifyHmac,
  engineWebhookTag,
  providerSharedSecret,
  providerWebhookPath,
  providerWebhookTag,
  verifyProviderWebhookTag,
  engineWebhookPath,
  verifyEngineWebhookTag,
  voiceToolPath,
  verifyVoiceToolTag,
  generateApiKey,
  hashApiKey,
  parseApiKeyEnv,
  type VerifyResult,
  type ApiKeyEnv,
  type GeneratedApiKey,
} from './signing.js';

export {
  money,
  paise,
  rupees,
  addMoney,
  multiplyMoney,
  compareMoney,
  grossMargin,
  formatMoney,
  type Money,
} from './money.js';

export {
  systemClock,
  fixedClock,
  isValidZone,
  inZone,
  addMinutes,
  addDays,
  parseHm,
  isoUtc,
  unixSeconds,
  type Clock,
} from './time.js';

export {
  loadEnv,
  baseEnv,
  databaseEnv,
  serviceDatabaseEnv,
  redisEnv,
  phoneHashEnv,
  phoneEncryptEnv,
  phoneDecryptEnv,
  staffEncryptEnv,
  staffDecryptEnv,
  shopifyTokenEnv,
  regionPeersEnv,
  shopifyTokenKeyring,
  trustProxyOf,
  type TrustProxyHops,
  type ShopifyTokenKeyring,
  type ShopifyTokenKeyringEnv,
} from './env.js';

export { parseSecretKey, seal, open as openSealed, type Sealed } from './secretbox.js';
export { isPrivateAddress, webhookUrlProblem } from './webhook-url.js';
