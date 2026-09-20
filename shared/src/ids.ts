import { monotonicFactory } from 'ulid';

/**
 * Prefixed ULIDs (CLAUDE.md: "IDs: ULIDs, prefixed"). ULID over UUIDv4 because these ids
 * sort by creation time, which matters when reading an audit trail or a call's attempts in
 * order. The prefix means a stray id in a log line or a support ticket is immediately
 * identifiable as an intent vs an attempt vs an outcome.
 *
 * `monotonicFactory` rather than the plain `ulid()`: within a single millisecond, plain
 * ULIDs use fresh random entropy and therefore do NOT sort by creation order. A worker
 * creating several attempts or audit rows in the same tick is ordinary, so the entropy has
 * to increment instead.
 *
 * Limit worth knowing: monotonicity is per-process. Two ids minted in the same millisecond
 * on two Cloud Run instances may sort either way. Order an audit trail by
 * `(at, id)` — the timestamp first, the id only as a tie-break.
 */
const ulid = monotonicFactory();
export const ID_PREFIXES = {
  // CLAUDE.md's six
  tenant: 'ten',
  intent: 'int',
  attempt: 'att',
  outcome: 'out',
  consent: 'con',
  suppression: 'sup',
  // the rest of the schema (db/src/schema); each table CHECKs its own prefix
  user: 'usr',
  apiKey: 'key',
  integration: 'itg',
  useCase: 'usc',
  script: 'scr',
  number: 'num',
  transferTarget: 'trf',
  contact: 'cnt',
  erasure: 'era',
  campaign: 'cmp',
  dispute: 'dsp',
  complaint: 'cpl',
  complaintReport: 'crp',
  billingSubscription: 'bsb',
  billingPosting: 'bps',
  ledger: 'led',
  audit: 'aud',
  webhookEvent: 'evt',
  merchantWebhook: 'whk',
  delivery: 'dlv',
  // inbound (ADR-0006)
  inboundProfile: 'ipr',
  knowledgeArticle: 'kba',
  order: 'ord',
  ticket: 'tkt',
  agentAction: 'act',
  orderAction: 'oac',
  // merchant dashboard sign-in (ADR-0009)
  loginToken: 'ltk',
  webSession: 'wss',
  notification: 'ntf',
  // promotional calling (ADR-0010)
  checkout: 'chk',
  attribution: 'atr',
  qaReview: 'qar',
  calendar: 'cal',
  appointment: 'apt',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type PrefixedId<K extends IdKind = IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

/** Crockford base32, as produced by ULID. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newId<K extends IdKind>(kind: K): PrefixedId<K> {
  return `${ID_PREFIXES[kind]}_${ulid()}` as PrefixedId<K>;
}

export function isId<K extends IdKind>(kind: K, value: string): value is PrefixedId<K> {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return false;
  return ULID_PATTERN.test(value.slice(prefix.length));
}

/**
 * Narrows an untrusted string to an id of the expected kind. Use at boundaries — a path
 * parameter naming an attempt must not be accepted where an intent is expected.
 */
export function parseId<K extends IdKind>(kind: K, value: string): PrefixedId<K> {
  if (!isId(kind, value)) {
    throw new TypeError(`Expected a ${kind} id (${ID_PREFIXES[kind]}_<ulid>)`);
  }
  return value;
}
