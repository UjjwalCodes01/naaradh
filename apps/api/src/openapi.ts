import { readFileSync } from 'node:fs';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { schema as db } from '@naaradh/db';
import {
  BusinessHours,
  DNC_REQUESTS_PER_IP_PER_HOUR,
  DNC_REQUESTS_PER_PHONE_PER_DAY,
  ERASURE_COMPLETION_TARGET_DAYS,
  GATE_REASONS,
  INBOUND_REASONS,
} from '@naaradh/compliance';
import {
  ATTESTATION_STATEMENT,
  AttestationInput,
  DISPUTE_WINDOW_DAYS,
  DNC_CONFIRMATION,
  KnowledgeInput,
  MERCHANT_EVENTS,
  PLANS,
  ProfileInput,
  SubscribeInput,
  TransferTargetInput,
  type MerchantEventType,
} from '@naaradh/pipeline';
import { TOOL_NAMES, USE_CASES } from '@naaradh/scripts';
import { ERROR_CODES, WEBHOOK_REPLAY_WINDOW_SEC, type ErrorCode } from '@naaradh/shared';
import { DisputeBody } from './routes/billing.js';
import { ConsentBody, RevokeBody, SuppressionBody } from './routes/consents.js';
import { CreateIntentBody } from './routes/intents.js';
import { ComplaintBody, DncBody, ErasureBody } from './routes/privacy.js';
import { OrderBody } from './routes/support.js';
import { CreateWebhookBody } from './routes/webhooks.js';

/**
 * The OpenAPI 3.1 description of api.naaradh.com (AGENTS §8, SPEC §9.1), generated from the
 * same Zod schemas the routes parse with, so a request the document accepts is a request the
 * server accepts. Served at `GET /v1/openapi.json`; committed as docs/api/openapi.json by
 * `pnpm openapi` and drift-checked in CI (AGENTS §12).
 *
 * Request schemas are converted (zod-to-json-schema, JSON Schema 2020-12-compatible output,
 * everything inlined). Response schemas are written by hand from what each handler returns —
 * where a handler passes through a free-form value the schema says so instead of inventing
 * fields. The unit test in test/unit/openapi.test.ts fails when a route exists that this
 * file does not document.
 */

// ---------------------------------------------------------------------------------------------
// Minimal OpenAPI object model. Plain JSON; no second dependency.
// ---------------------------------------------------------------------------------------------

/** A JSON Schema fragment or any other OpenAPI object: plain JSON we never introspect. */
export type Schema = Record<string, unknown>;

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

export interface OperationObject {
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description: string;
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly parameters?: readonly Schema[];
  readonly requestBody?: Schema;
  readonly responses: Readonly<Record<string, Schema>>;
}

export type PathItemObject = Partial<Record<HttpMethod, OperationObject>>;

export interface OpenAPIObject {
  readonly openapi: '3.1.0';
  readonly jsonSchemaDialect: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly summary: string;
    readonly description: string;
    readonly contact: { readonly name: string; readonly url: string };
  };
  readonly servers: readonly { readonly url: string; readonly description: string }[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly security: readonly Record<string, readonly string[]>[];
  readonly paths: Readonly<Record<string, PathItemObject>>;
  readonly webhooks: Readonly<Record<string, PathItemObject>>;
  readonly components: {
    readonly securitySchemes: Readonly<Record<string, Schema>>;
    readonly schemas: Readonly<Record<string, Schema>>;
    readonly responses: Readonly<Record<string, Schema>>;
    readonly parameters: Readonly<Record<string, Schema>>;
    readonly headers: Readonly<Record<string, Schema>>;
  };
}

// ---------------------------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const withDescription = (s: Schema, description?: string): Schema =>
  description === undefined ? s : { ...s, description };

/** Zod → JSON Schema, inlined (no `$ref`), without the draft-07 `$schema` marker. */
function fromZod(zod: ZodTypeAny, description?: string): Schema {
  // ZodTypeAny is `ZodType<any, …>` by definition; the converter accepts exactly that.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const { $schema: _dialect, ...json } = zodToJsonSchema(zod, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  });
  return withDescription(json, description);
}

/** Adds property descriptions to a converted object schema (Zod carries none of its JSDoc). */
function documentProperties(s: Schema, docs: Readonly<Record<string, string>>): Schema {
  const props = s['properties'];
  if (!isRecord(props)) return s;
  const out: Record<string, unknown> = { ...props };
  for (const [key, description] of Object.entries(docs)) {
    const p = out[key];
    if (isRecord(p)) out[key] = { ...p, description };
  }
  return { ...s, properties: out };
}

const str = (description?: string, extra: Schema = {}): Schema =>
  withDescription({ type: 'string', ...extra }, description);
const int = (description?: string): Schema => withDescription({ type: 'integer' }, description);
const num = (description?: string): Schema => withDescription({ type: 'number' }, description);
const bool = (description?: string): Schema => withDescription({ type: 'boolean' }, description);
const dateTime = (description?: string): Schema =>
  withDescription({ type: 'string', format: 'date-time' }, description);
const constOf = (value: string | boolean | number, description?: string): Schema =>
  withDescription(
    {
      type:
        typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : 'integer',
      const: value,
    },
    description,
  );
const enumOf = (values: readonly string[], description?: string): Schema =>
  withDescription({ type: 'string', enum: [...values] }, description);
const arr = (items: Schema, description?: string): Schema =>
  withDescription({ type: 'array', items }, description);
const nullable = (s: Schema): Schema =>
  typeof s['type'] === 'string'
    ? { ...s, type: [s['type'], 'null'] }
    : { anyOf: [s, { type: 'null' }] };
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** An object whose every listed property is present in the response (nullable where noted). */
const obj = (
  properties: Readonly<Record<string, Schema>>,
  description?: string,
  options: { readonly optional?: readonly string[] } = {},
): Schema =>
  withDescription(
    {
      type: 'object',
      properties,
      required: Object.keys(properties).filter((k) => !(options.optional ?? []).includes(k)),
    },
    description,
  );

/** A value the API passes through without shaping it. Says so rather than inventing fields. */
const freeForm = (description: string): Schema => ({
  type: 'object',
  additionalProperties: true,
  description,
});

const oneOf = (...variants: readonly Schema[]): Schema => ({ oneOf: [...variants] });

// ---------------------------------------------------------------------------------------------
// Vocabulary shared by requests, responses and webhooks
// ---------------------------------------------------------------------------------------------

const ID_ULID = '26-character ULID with a type prefix';
const lower = (values: readonly string[]): string[] => values.map((v) => v.toLowerCase());

const GATE_REASON_KEYS = Object.keys(GATE_REASONS);
const INBOUND_REASON_KEYS = Object.keys(INBOUND_REASONS);
/** packages/pipeline/src/intents.ts `SkipReason` (a type, so listed here). */
const SKIP_REASONS = [
  'use_case_disabled',
  'test_order',
  'staff_customer',
  'skip_tag',
  'below_min_value',
  'pilot_excluded',
  'no_use_case',
] as const;

/** apps/api/src/errors.ts STATUS_BY_CODE — the status each error code answers with. */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  GATED: 409,
  ENGINE_UNAVAILABLE: 503,
  IDEMPOTENT_REPLAY: 200,
  SIGNATURE_INVALID: 401,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  DISPATCH_UNCERTAIN: 500,
  INTERNAL: 500,
};

const outboundPlanCodes = Object.values(PLANS)
  .filter((p) => p.kind === 'outbound')
  .map((p) => p.code);
const inboundPlanCodes = Object.values(PLANS)
  .filter((p) => p.kind === 'inbound')
  .map((p) => p.code);

// ---------------------------------------------------------------------------------------------
// components.schemas
// ---------------------------------------------------------------------------------------------

const ErrorSchema: Schema = obj(
  {
    error: obj(
      {
        code: enumOf(
          ERROR_CODES,
          `Machine-readable code. Status by code: ${ERROR_CODES.map((c) => `${c} → ${String(STATUS_BY_CODE[c])}`).join(', ')}. Fastify's own client errors (malformed JSON, unsupported media type, body over 256 KiB) use Fastify's \`FST_ERR_*\` codes with the same envelope.`,
        ),
        message: str('Human-readable, safe to show to an operator; never contains a phone number.'),
        details: freeForm(
          'Optional. For VALIDATION_FAILED from the schema: an array of `{path, message}` issues. Otherwise the error context (flat key/values), when any.',
        ),
        request_id: str(
          'Echo of the request id (`x-cloud-trace-context` when present). Quote it in support requests.',
        ),
      },
      undefined,
      { optional: ['details'] },
    ),
  },
  'The error envelope every non-2xx response uses, except the per-minute rate limiter (see RateLimitError).',
);

const RateLimitErrorSchema: Schema = obj(
  {
    statusCode: constOf(429),
    code: constOf('RATE_LIMITED'),
    error: constOf('Too Many Requests'),
    message: str('e.g. "rate limit exceeded, retry in 12s"'),
    request_id: str(),
  },
  'The flat body of the per-minute limiter (@fastify/rate-limit). The per-key DAILY intent cap answers 429 with the standard Error envelope instead.',
);

const GateInfo = {
  reason: enumOf(
    GATE_REASON_KEYS,
    'Machine code stored on the intent (`call_intents.gated_reason`).',
  ),
  title: str('Short label for the reason.'),
  explanation: str('Plain-language explanation shown to merchants.'),
  hint: str('What the merchant can do about it, if anything.'),
};

const IntentStatus = enumOf(
  lower(db.intentStatus.enumValues),
  'Intent lifecycle (SPEC §11), lower-cased.',
);
const AttemptStatus = enumOf(
  lower(db.attemptStatus.enumValues),
  'Attempt lifecycle (SPEC §11), lower-cased.',
);
const Outcome = enumOf(
  db.outcome.enumValues,
  'Call outcome (SPEC §6.5). Only `confirmed`, `confirmed_with_changes`, `cancelled`, `rescheduled`, `booked` — with a human answering — are billable (invariant 11).',
);
const AnsweredBy = enumOf(db.answeredBy.enumValues);

const AttemptView = obj({
  attempt_id: str(ID_ULID),
  attempt_no: int('1-based, in dispatch order.'),
  status: AttemptStatus,
  dispatched_at: nullable(dateTime()),
  answered_at: nullable(dateTime()),
  ended_at: nullable(dateTime()),
  answered_by: nullable(AnsweredBy),
  end_reason: nullable(str('Engine-reported end reason, as received.')),
  duration_sec: nullable(int()),
  recording: nullable(
    str(
      'Relative path of the recording endpoint (`/v1/calls/{id}/recording`) when a recording exists; never the storage URL.',
    ),
  ),
});

const OutcomeView = obj({
  outcome_id: str(ID_ULID),
  outcome: Outcome,
  confidence: num('0–1.'),
  billable: bool('Fixed by invariant 11; disputes go through POST /v1/outcomes/{id}/disputes.'),
  superseded: bool('True when a later event overtook this outcome (E-40); never billable.'),
  extracted: freeForm(
    'Structured values extracted from the call (e.g. reschedule date, change notes). Keys depend on the use case; never contains a phone number or address text written by the agent.',
  ),
  at: dateTime(),
});

const IntentView = obj(
  {
    intent_id: str(ID_ULID),
    use_case: enumOf(USE_CASES),
    status: IntentStatus,
    external_refs: arr(
      str(),
      'Every external_ref merged into this intent (E-42: several orders, one call).',
    ),
    phone_masked: nullable(
      str('Masked recipient number, e.g. `+91 6XXXX XX123`. The raw number is never returned.'),
    ),
    event_ts: dateTime(),
    not_before: dateTime('Earliest dial time (recipient calling window).'),
    not_after: dateTime(
      'Deadline after which the intent expires (30 minutes for transactional COD confirmation, invariant 4).',
    ),
    next_attempt_at: nullable(dateTime()),
    attempts_count: int(),
    cancelled_at: nullable(dateTime()),
    gated: nullable(obj(GateInfo, 'Present when the last evaluation refused the call.')),
    attempts: arr(AttemptView),
    outcome: nullable(OutcomeView),
    created_at: dateTime(),
  },
  'Status, attempts and outcome of one intent (GET /v1/intents/{id}).',
);

const BusinessHoursSchema = fromZod(
  BusinessHours,
  "Opening hours in the merchant's own IANA zone. `days` are ISO weekdays (1 = Monday … 7 = Sunday); `open` is inclusive and `close` exclusive, both `HH:MM`.",
);

const ProfileView = obj(
  {
    id: str(ID_ULID),
    name: str(),
    version: int('Incremented by the database on every configuration change.'),
    status: enumOf(db.profileStatus.enumValues),
    locale: str('`xx-XX`'),
    greeting: str(
      'First utterance. Must contain the AI and recording disclosure (invariant 7); validated on create, update and activation.',
    ),
    persona: nullable(str()),
    pinned_facts: arr(str()),
    tools_enabled: arr(enumOf(TOOL_NAMES)),
    closed_message: str(),
    business_hours: ref('BusinessHours'),
    fallback_forward: nullable(
      str(
        'Masked staff number the line forwards to when the agent cannot answer (E-92). Never the raw number.',
      ),
    ),
    transfer_target_id: nullable(str()),
    max_duration_sec: int(),
    max_concurrent: int(),
    max_calls_per_caller_hour: int('Per-caller hourly limit (E-88).'),
    monthly_minute_cap: nullable(int()),
    agent_cancel_enabled: bool(
      'Invariant 14: off by default; when on, the agent may cancel an unshipped COD order after the two-step confirmation.',
    ),
    voice_id: nullable(str()),
    updated_at: dateTime(),
  },
  'An inbound profile as the API returns it.',
);

const DirectionUsage = obj(
  {
    plan: nullable(str('Plan code, or null when no plan is attached for this direction.')),
    included: int(
      'Units included in the plan for the period (outcomes for outbound, minutes for inbound).',
    ),
    used: int('Units consumed this period.'),
    extra: int('Units charged beyond the allowance.'),
    extraAmountMinor: int(
      'Charged amount for the extra units, in minor currency units (paise/cents).',
    ),
    unitMinor: int('Price per extra unit, minor units.'),
    feeMinor: int('Platform fee for the period, minor units.'),
  },
  'Usage for one direction (outbound outcomes or inbound minutes). Keys are camelCase as returned.',
);

const MerchantWebhookView = obj({
  webhook_id: str(ID_ULID),
  url: str('https only.', { format: 'uri' }),
  events: arr(enumOf(MERCHANT_EVENTS)),
  active: bool('False once deleted, or auto-disabled after 20 consecutive delivery failures.'),
  consecutive_failures: int(),
  disabled_reason: nullable(str()),
  created_at: dateTime(),
});

const DeliveryView = obj(
  {
    id: str(ID_ULID),
    webhookId: str(),
    eventType: enumOf(MERCHANT_EVENTS),
    eventId: str(
      'Stable event id (the `id` in the delivered payload); duplicates carry the same id.',
    ),
    status: enumOf(db.deliveryStatus.enumValues),
    attempts: int(),
    lastStatusCode: nullable(int()),
    lastError: nullable(str()),
    nextAttemptAt: nullable(dateTime()),
    createdAt: dateTime(),
  },
  'A delivery attempt log entry. Note: this endpoint returns camelCase keys, as implemented.',
);

const TicketView = obj({
  id: str(ID_ULID),
  category: enumOf(db.ticketCategory.enumValues),
  summary: str(
    'What the caller needed, written by the agent from the conversation (1–1000 characters).',
  ),
  status: enumOf(db.ticketStatus.enumValues),
  priority: int('Higher first. 90 for a handed-over cancellation; default 50.'),
  callback_requested: bool(),
  preferred_time: nullable(str('Free text the caller gave for a callback.')),
  order_id: nullable(str('Naaradh order id (`ord_…`), when the ticket is about an order.')),
  order_name: nullable(str('The order number as the store shows it.')),
  attempt_id: nullable(str()),
  created_at: dateTime(),
});

const DisputeView = obj({
  id: str(ID_ULID),
  outcome_id: str(),
  status: enumOf(db.disputeStatus.enumValues),
  reason: str(),
  resolution: nullable(str('Staff note when accepted or rejected.')),
  opened_at: dateTime(),
  resolved_at: nullable(dateTime()),
});

const componentSchemas: Record<string, Schema> = {
  Error: ErrorSchema,
  RateLimitError: RateLimitErrorSchema,
  BusinessHours: BusinessHoursSchema,
  IntentView,
  ProfileView,
  DirectionUsage,
  MerchantWebhook: MerchantWebhookView,
  WebhookDelivery: DeliveryView,
  Ticket: TicketView,
  Dispute: DisputeView,
};

// ---------------------------------------------------------------------------------------------
// components.responses / parameters / headers
// ---------------------------------------------------------------------------------------------

const jsonResponse = (
  description: string,
  s: Schema,
  headers?: Readonly<Record<string, Schema>>,
): Schema => ({
  description,
  ...(headers === undefined ? {} : { headers }),
  content: { 'application/json': { schema: s } },
});

const errorResponse = (description: string): Schema => jsonResponse(description, ref('Error'));

const componentResponses: Record<string, Schema> = {
  BadRequest: errorResponse(
    'Malformed JSON, unsupported media type, or a body over 256 KiB (Fastify `FST_ERR_*` code in the envelope).',
  ),
  Unauthenticated: errorResponse(
    '`UNAUTHENTICATED` — missing, malformed, unknown or revoked API key. Keys look like `nrd_live_…`, `nrd_test_…` or `nrd_pk_…`.',
  ),
  Forbidden: errorResponse(
    "`FORBIDDEN` — the key lacks the scope, the request IP is outside the key's allow-list (E-70), a public key was used from an Origin outside its domain list or for anything but `lead_callback`, or the account is suspended/uninstalled.",
  ),
  NotFound: errorResponse(
    '`NOT_FOUND` — the id does not exist, or belongs to another tenant (row-level security makes those indistinguishable).',
  ),
  ValidationFailed: errorResponse(
    '`VALIDATION_FAILED` — the body did not match the schema (`details` lists `{path, message}` issues), a phone number could not be parsed, a timestamp is in the future, or an `Idempotency-Key` was reused with a different request.',
  ),
  RateLimited: {
    description:
      '`RATE_LIMITED`. The per-minute limiter answers with the flat `RateLimitError` body; the per-key daily intent cap (E-70) answers with the standard `Error` envelope and `Retry-After: 3600`.',
    headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
    content: { 'application/json': { schema: oneOf(ref('RateLimitError'), ref('Error')) } },
  },
  EngineUnavailable: {
    description:
      '`ENGINE_UNAVAILABLE` — a dependency is not configured or is temporarily failing; retry after `Retry-After` when present.',
    headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
    content: { 'application/json': { schema: ref('Error') } },
  },
  Internal: errorResponse(
    '`INTERNAL` — unexpected error; quote `request_id` to support. Nothing internal is disclosed.',
  ),
};

const componentParameters: Record<string, Schema> = {
  IdempotencyKey: {
    name: 'Idempotency-Key',
    in: 'header',
    required: false,
    description:
      'Any string up to 200 characters, unique per request you intend once (a UUID is fine). Honoured on POST for 24 hours per tenant: a replay with the same key AND the same method, URL and body returns the original response — same status, same body — with `Idempotent-Replay: true`. The same key with a different request is a 422 `VALIDATION_FAILED`. Responses ≥ 500 are not stored, so a failed request may be retried with the same key.',
    schema: { type: 'string', minLength: 1, maxLength: 200 },
  },
};

const componentHeaders: Record<string, Schema> = {
  IdempotentReplay: {
    description:
      'Present (value `true`) when this response was replayed from a stored `Idempotency-Key`.',
    schema: { type: 'string', const: 'true' },
  },
  RetryAfter: {
    description: 'Seconds to wait before retrying.',
    schema: { type: 'integer', minimum: 0 },
  },
};

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

type Tag =
  | 'Intents'
  | 'Consents & suppressions'
  | 'Calls'
  | 'Merchant webhooks'
  | 'Billing'
  | 'Privacy'
  | 'Support line'
  | 'Reference';

const TAGS: readonly { name: Tag; description: string }[] = [
  {
    name: 'Intents',
    description:
      "A call intent is a request that Naaradh call one customer for one purpose (COD confirmation, abandoned checkout, appointment, lead callback…). Every intent passes the compliance gate before dialling — calling window in the recipient's zone, consent for promotional purposes, suppressions, DND, attempt limits, kill switches — and the outcome comes back as a webhook and on GET /v1/intents/{id}.",
  },
  {
    name: 'Consents & suppressions',
    description:
      'The consent ledger (who agreed to what, with which wording, when) and suppressions (numbers that must never be called for a purpose). Promotional use cases (`abandoned_cart`, `feedback`, `reactivation`) require an unexpired, unrevoked consent row — one is never inferred from a phone number existing on an order (invariant 5). Suppressions are absolute and cover transactional calls too (invariant 6).',
  },
  {
    name: 'Calls',
    description:
      'Access to call artefacts. Recordings are served as short-lived signed URLs and every access is audited (E-74).',
  },
  {
    name: 'Merchant webhooks',
    description:
      'Register HTTPS endpoints that receive signed events (`X-Naaradh-Signature`) when intents, calls, outcomes, tickets, orders, complaints and billing change state. Delivery is at-least-once with retries; dedupe on the event `id`. See the `webhooks` section of this document for each payload.',
  },
  {
    name: 'Billing',
    description:
      'Plan, allowance and usage for the period; outcome disputes (E-62). Shopify-installed merchants are billed only through the Shopify Billing API, so the Razorpay route refuses them. Outbound is billed per billable outcome, inbound per connected minute (ADR-0006).',
  },
  {
    name: 'Privacy',
    description:
      'Complaints, erasure requests and the public do-not-call endpoint. Phone numbers arrive here and leave as keyed hashes; the API never stores a number it can read back.',
  },
  {
    name: 'Support line',
    description:
      'Configuration and data of the inbound AI support line (ADR-0006): inbound profiles (who answers, how, with which tools), the knowledge base the agent may quote, verified transfer targets (invariant 19), the tickets the agent raised, and the order cache the agent answers from for non-Shopify merchants.',
  },
  {
    name: 'Reference',
    description: 'This document.',
  },
];

interface OperationInput {
  readonly id: string;
  readonly tag: Tag;
  readonly summary: string;
  readonly description: string;
  /** Scope a secret key needs; `null` for endpoints that take no API key. */
  readonly scope: string | null;
  /** Also callable with a public site key (`nrd_pk_…`). */
  readonly publicKey?: boolean;
  readonly params?: readonly Schema[];
  readonly body?: Schema;
  readonly bodyDescription?: string;
  readonly responses: Readonly<Record<string, Schema>>;
  /** Extra component responses beyond the standard set for the auth kind. */
  readonly errors?: readonly (keyof typeof componentResponses)[];
}

const pathParam = (name: string, description: string): Schema => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

const respRef = (name: keyof typeof componentResponses): Schema => ({
  $ref: `#/components/responses/${name}`,
});

function operation(method: HttpMethod, input: OperationInput): OperationObject {
  const authenticated = input.scope !== null;
  const hasBody = input.body !== undefined;
  const params: Schema[] = [...(input.params ?? [])];
  if (authenticated && method === 'post')
    params.push({ $ref: '#/components/parameters/IdempotencyKey' });

  const errors = new Map<number, Schema>();
  if (hasBody) {
    errors.set(400, respRef('BadRequest'));
    errors.set(422, respRef('ValidationFailed'));
  }
  if (authenticated) {
    errors.set(401, respRef('Unauthenticated'));
    errors.set(403, respRef('Forbidden'));
  }
  errors.set(429, respRef('RateLimited'));
  errors.set(500, respRef('Internal'));
  for (const name of input.errors ?? []) {
    const status =
      name === 'NotFound'
        ? 404
        : name === 'EngineUnavailable'
          ? 503
          : name === 'ValidationFailed'
            ? 422
            : name === 'Forbidden'
              ? 403
              : 400;
    errors.set(status, respRef(name));
  }

  const success: Record<string, Schema> = {};
  for (const [status, response] of Object.entries(input.responses)) {
    success[status] =
      authenticated && method === 'post'
        ? {
            ...response,
            headers: {
              ...(isRecord(response['headers']) ? response['headers'] : {}),
              'Idempotent-Replay': { $ref: '#/components/headers/IdempotentReplay' },
            },
          }
        : response;
  }
  const responses: Record<string, Schema> = { ...success };
  for (const [status, response] of [...errors.entries()].sort((a, b) => a[0] - b[0]))
    responses[String(status)] = response;

  const scope = input.scope;
  const security: Record<string, readonly string[]>[] =
    scope === null
      ? []
      : input.publicKey === true
        ? [{ secretKey: [scope] }, { publicSiteKey: [scope] }]
        : [{ secretKey: [scope] }];

  const description =
    scope === null
      ? `${input.description}\n\nNo API key.`
      : `${input.description}\n\nScope: \`${scope}\`.${input.publicKey === true ? ' Accepts a public site key (`nrd_pk_…`) from an allow-listed Origin.' : ''}`;

  return {
    operationId: input.id,
    tags: [input.tag],
    summary: input.summary,
    description,
    security,
    ...(params.length === 0 ? {} : { parameters: params }),
    ...(input.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            ...(input.bodyDescription === undefined ? {} : { description: input.bodyDescription }),
            content: { 'application/json': { schema: input.body } },
          },
        }),
    responses,
  };
}

const PHONE_DOCS: Readonly<Record<string, string>> = {
  phone:
    'Any format your system has (`+91 60000 00123`, `060000 00123`, `6000000123`). Normalised to E.164 on receipt; the raw string is never stored and never returned — responses carry a masked form only.',
  phone_region:
    "ISO 3166-1 alpha-2 country used to interpret a number without a country code. Rules (calling window, consent type, disclosure language) follow the RECIPIENT's number, not this field (invariant 2).",
};

// ---- Intents -----------------------------------------------------------------------------------------

const intentAccepted = (status: string, extra: Record<string, Schema> = {}): Schema =>
  obj({ intent_id: str(ID_ULID), status: constOf(status), ...extra });

const intentOps: Record<string, PathItemObject> = {
  '/v1/intents': {
    post: operation('post', {
      id: 'createIntent',
      tag: 'Intents',
      summary: 'Create a call intent',
      description:
        "Asks Naaradh to call one customer for one use case. The request is validated at the boundary, then goes through the same `createIntent()` the Shopify integration uses, so the API can never bypass a rule: the number is normalised and hashed, the use case must be enabled on your account, duplicates (`external_ref` + use case) are detected, several open intents for the same number are merged into one call (E-42), and the compliance gate decides between `scheduled` and `gated`. COD confirmation is transactional only when dialled within 30 minutes of `event_ts` (invariant 4); `event_ts` therefore defaults to now and may not be in the future. Promotional use cases need a consent — send it inline in `consent` or record it first with POST /v1/consents. Public site keys may only create `lead_callback` intents (SPEC §9.2). Counts against the key's daily intent cap (E-70).",
      scope: 'intents:create',
      publicKey: true,
      body: documentProperties(fromZod(CreateIntentBody), {
        ...PHONE_DOCS,
        use_case:
          'Must be enabled for your account; otherwise the response is `skipped` with reason `use_case_disabled`.',
        name: "Customer's name, used only as the `customer_name` script variable. Not stored on the contact.",
        external_ref:
          'Your id for the order, lead or appointment. Duplicate (`external_ref`, `use_case`) pairs return the existing intent (E-52).',
        event_ts:
          'When the customer acted (order placed, form submitted). Defaults to now; must not be more than 60 s in the future.',
        appointment_ts: 'For appointment use cases: the appointment time.',
        variables:
          'Script variables. Only the keys the use case allows are kept (E-72); values are sanitised before reaching the model.',
        locale: "`xx-XX`, e.g. `hi-IN`. Defaults to the use case's locale.",
        timezone: 'IANA zone of the recipient when known; otherwise derived from the number.',
        value_minor: 'Order/cart value in minor units (paise/cents), used for minimum-value rules.',
        currency: 'ISO 4217.',
        consent:
          'Consent captured at the same moment (checkout box, form checkbox). Recorded in the ledger before the gate runs. `attestation` is not accepted here — use POST /v1/consents.',
      }),
      responses: {
        '202': jsonResponse(
          'Accepted. `scheduled`: the call will be dialled inside [`not_before`, `not_after`]. `merged`: an open intent for the same number will cover this reference too (one call, several orders). `gated`: refused by a compliance rule; nothing will be dialled unless the rule is temporary and the intent is re-evaluated (`hint` says what you can do).',
          oneOf(
            intentAccepted('scheduled', { not_before: dateTime(), not_after: dateTime() }),
            intentAccepted('merged'),
            intentAccepted('gated', GateInfo),
          ),
        ),
        '200': jsonResponse(
          "Nothing new was created. `duplicate`: the same `external_ref` + `use_case` already exists (its id is returned). `skipped`: the account's rules exclude this event (use case disabled, test order, staff customer, below minimum value…); `intent_id` is null.",
          oneOf(
            intentAccepted('duplicate'),
            obj({
              intent_id: { type: 'null' },
              status: constOf('skipped'),
              reason: enumOf(SKIP_REASONS),
            }),
          ),
        ),
      },
    }),
  },
  '/v1/intents/{id}': {
    get: operation('get', {
      id: 'getIntent',
      tag: 'Intents',
      summary: 'Get an intent with its attempts and outcome',
      description:
        'Current status of an intent, every attempt made (with a relative link to the recording where one exists), the latest outcome and — when gated — the reason with its explanation. The recipient number is returned masked only.',
      scope: 'intents:read',
      params: [pathParam('id', 'Intent id (`int_…`) from POST /v1/intents.')],
      responses: { '200': jsonResponse('The intent.', ref('IntentView')) },
      errors: ['NotFound'],
    }),
  },
  '/v1/intents/{id}/cancel': {
    post: operation('post', {
      id: 'cancelIntent',
      tag: 'Intents',
      summary: 'Cancel an intent',
      description:
        'Cancels a queued intent so it is never dialled (the customer cancelled, paid online, or you no longer want the call). An attempt already in progress cannot be pulled back; it is flagged so its outcome is marked superseded and never billed (E-40), and the response says `cancel_requested`. A terminal intent (completed, expired, already cancelled) answers `cancelled: false` with its current status.',
      scope: 'intents:create',
      params: [pathParam('id', 'Intent id (`int_…`).')],
      responses: {
        '200': jsonResponse(
          'Result of the cancellation.',
          obj({
            intent_id: str(),
            status: oneOf(constOf('cancelled'), constOf('cancel_requested'), IntentStatus),
            cancelled: bool('False when the intent was already terminal.'),
          }),
        ),
      },
      errors: ['NotFound'],
    }),
  },
};

// ---- Consents & suppressions -------------------------------------------------------------------------

const consentOps: Record<string, PathItemObject> = {
  '/v1/consents': {
    post: operation('post', {
      id: 'recordConsent',
      tag: 'Consents & suppressions',
      summary: 'Record a consent',
      description:
        "Writes a consent row for a number and purpose with its evidence (source, wording version, evidence URI, capture time). The number is hashed on receipt. Promotional calls require a `promotional` or `all` consent from a written source; an `attestation` (you assert consent exists elsewhere) is recorded but does NOT unlock promotional calls (E-08) — the response says so in `sufficient_for_promotional`. Consents expire per the rules of the recipient's region; `expires_at` tells you when.",
      scope: 'consents:write',
      body: documentProperties(fromZod(ConsentBody), {
        ...PHONE_DOCS,
        purpose:
          '`service` covers service/transactional follow-ups; `promotional` covers marketing use cases; `all` both.',
        source:
          'How the consent was obtained. `*_written` means the customer saw and accepted written wording (checkbox); `verbal` and `attestation` are weaker.',
        wording_version: 'Your version label for the wording the customer saw.',
        evidence_uri: 'Where the evidence lives in your system (screenshot, form record).',
        captured_at: 'When the customer consented. Defaults to now; must not be in the future.',
        external_ref: 'Your reference (order, lead).',
      }),
      responses: {
        '201': jsonResponse(
          'Recorded.',
          obj({
            consent_id: str(ID_ULID),
            expires_at: nullable(
              dateTime('When this consent stops satisfying the gate; null when indefinite.'),
            ),
            sufficient_for_promotional: bool('False for `attestation` sources.'),
          }),
        ),
      },
    }),
    delete: operation('delete', {
      id: 'revokeConsent',
      tag: 'Consents & suppressions',
      summary: 'Revoke consent',
      description:
        'Revokes every unrevoked consent for the number and purpose (`all` revokes everything). Takes a JSON body. Returns how many rows were revoked; zero is not an error. Revocation does not suppress transactional calls — use POST /v1/suppressions for that.',
      scope: 'consents:write',
      body: documentProperties(fromZod(RevokeBody), PHONE_DOCS),
      responses: {
        '200': jsonResponse('Done.', obj({ revoked: int('Number of consent rows revoked.') })),
      },
    }),
  },
  '/v1/suppressions': {
    post: operation('post', {
      id: 'createSuppression',
      tag: 'Consents & suppressions',
      summary: 'Suppress a number',
      description:
        'Adds a tenant-scoped suppression: the number will not be called for the purpose (`all` by default) by your account, including transactional calls — suppressions are absolute (invariant 6). An `opt_out` also blocks new intents for that number for 90 days regardless of new orders (E-03). Idempotent: an existing suppression answers 200 with `created: false`. Emits the `suppression.created` webhook when new.',
      scope: 'suppressions:write',
      body: documentProperties(fromZod(SuppressionBody), {
        ...PHONE_DOCS,
        reason:
          '`opt_out` (the person asked), `manual` (your decision), `wrong_number`, `invalid`.',
        notes: 'Free text for your own records; never shown to the customer.',
      }),
      responses: {
        '201': jsonResponse(
          'Created.',
          obj({
            suppression_id: str(ID_ULID),
            created: constOf(true),
            until: nullable(dateTime('Expiry; null when indefinite.')),
          }),
        ),
        '200': jsonResponse(
          'Already suppressed.',
          obj({
            suppression_id: str(ID_ULID),
            created: constOf(false),
            until: nullable(dateTime()),
          }),
        ),
      },
    }),
  },
};

// ---- Calls -------------------------------------------------------------------------------------------

const callOps: Record<string, PathItemObject> = {
  '/v1/calls/{id}/recording': {
    get: operation('get', {
      id: 'getRecordingUrl',
      tag: 'Calls',
      summary: 'Get a signed recording URL',
      description:
        "Returns a URL for the call recording, valid for 15 minutes. Recordings live in Naaradh's own storage (the engine's URL is never returned, E-34) and every access is written to the audit log with your key id (E-74). 404 when the attempt has no recording (not answered, recording refused, retention expired).",
      scope: 'calls:read',
      params: [pathParam('id', "Attempt id (`att_…`) from the intent's `attempts[].attempt_id`.")],
      responses: {
        '200': jsonResponse(
          'A signed URL.',
          obj({
            url: str('Fetch with GET, no credentials.', { format: 'uri' }),
            expires_at: dateTime(),
          }),
        ),
      },
      errors: ['NotFound'],
    }),
  },
};

// ---- Merchant webhooks -------------------------------------------------------------------------------

const webhookOps: Record<string, PathItemObject> = {
  '/v1/webhooks': {
    post: operation('post', {
      id: 'createWebhook',
      tag: 'Merchant webhooks',
      summary: 'Register a webhook endpoint',
      description:
        'Registers an HTTPS endpoint for a set of event types. The signing `secret` (`whsec_…`) is returned exactly once, in this response — Naaradh stores only a reference to it. Every delivery is signed with it (see the `webhooks` section: `X-Naaradh-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`, 5-minute replay window).',
      scope: 'webhooks:write',
      body: documentProperties(fromZod(CreateWebhookBody), {
        url: 'Must be `https://`. Redirects are not followed.',
        events: 'Event types to deliver to this endpoint.',
      }),
      responses: {
        '201': jsonResponse(
          'Registered. Store `secret` now.',
          obj({
            webhook_id: str(ID_ULID),
            url: str(),
            events: arr(enumOf(MERCHANT_EVENTS)),
            secret: str(
              '`whsec_` + 32 url-safe base64 characters. Not retrievable later; delete and re-create to rotate.',
            ),
            note: constOf('store the secret now; it is not retrievable later'),
          }),
        ),
      },
    }),
    get: operation('get', {
      id: 'listWebhooks',
      tag: 'Merchant webhooks',
      summary: 'List webhook endpoints',
      description:
        'Every endpoint registered for your account, active or not, newest first. Secrets are never included.',
      scope: 'webhooks:read',
      responses: {
        '200': jsonResponse('Endpoints.', obj({ webhooks: arr(ref('MerchantWebhook')) })),
      },
    }),
  },
  '/v1/webhooks/{id}': {
    delete: operation('delete', {
      id: 'deleteWebhook',
      tag: 'Merchant webhooks',
      summary: 'Delete a webhook endpoint',
      description:
        'Deactivates the endpoint (kept for the delivery history, `disabled_reason: "deleted via api"`). Pending deliveries to it are dead-lettered. 404 when it does not exist or is already inactive.',
      scope: 'webhooks:write',
      params: [pathParam('id', 'Webhook id (`mwh_…`).')],
      responses: { '204': { description: 'Deleted.' } },
      errors: ['NotFound'],
    }),
  },
  '/v1/webhooks/deliveries': {
    get: operation('get', {
      id: 'listWebhookDeliveries',
      tag: 'Merchant webhooks',
      summary: 'List recent deliveries',
      description:
        'The last 100 delivery attempts across your endpoints, newest first: status (`pending`, `delivered`, `failed` — will retry, `dead` — gave up after 5 attempts), attempt count, last HTTP status and error, next attempt time. Use it to debug an endpoint before asking for a redelivery.',
      scope: 'webhooks:read',
      responses: {
        '200': jsonResponse('Deliveries.', obj({ deliveries: arr(ref('WebhookDelivery')) })),
      },
    }),
  },
};

// ---- Billing -----------------------------------------------------------------------------------------

const billingOps: Record<string, PathItemObject> = {
  '/v1/billing': {
    get: operation('get', {
      id: 'getBilling',
      tag: 'Billing',
      summary: 'Plan, allowance and usage for the current period',
      description:
        'What the billing page shows: the calendar-month period, plan and allowance per direction, units used and charged beyond the allowance, credits from accepted disputes, the state of usage postings at the provider, and the subscription as Naaradh last fetched it. Amounts are integers in minor units (paise/cents) with the currency alongside.',
      scope: 'billing:read',
      responses: {
        '200': jsonResponse(
          'Usage summary.',
          obj({
            period: str('`YYYY-MM` (UTC).'),
            currency: enumOf(['INR', 'USD']),
            billing_status: enumOf(db.billingStatus.enumValues),
            billing_provider: nullable(enumOf(db.billingProvider.enumValues)),
            grace_until: nullable(
              dateTime('End of the 3-day grace period after a declined payment (E-50).'),
            ),
            outbound: ref('DirectionUsage'),
            inbound: ref('DirectionUsage'),
            credits_minor: int('Credits applied this period (positive number), minor units.'),
            postings: {
              type: 'object',
              additionalProperties: { type: 'integer' },
              description: `Count of usage postings by status this period. Keys: ${db.billingPostingStatus.enumValues.join(', ')}.`,
            },
            subscription: nullable(
              obj(
                {
                  provider: enumOf(db.billingProvider.enumValues),
                  status: enumOf(db.billingSubscriptionStatus.enumValues),
                  currentPeriodEnd: nullable(
                    dateTime('Same value as `current_period_end` (both keys are returned).'),
                  ),
                  cappedAmountMinor: nullable(int('Shopify capped amount (E-61), minor units.')),
                  current_period_end: nullable(dateTime()),
                },
                'The most recent subscription row, or null.',
              ),
            ),
          }),
        ),
      },
    }),
  },
  '/v1/billing/razorpay/subscribe': {
    post: operation('post', {
      id: 'subscribeRazorpay',
      tag: 'Billing',
      summary: 'Start a Razorpay subscription (direct INR merchants)',
      description: `Creates a Razorpay subscription for the chosen plan combination and returns the mandate authorisation URL; the subscription becomes active when Razorpay's webhook is confirmed by a re-fetch. Outbound plan codes: ${outboundPlanCodes.map((c) => `\`${c}\``).join(', ')}. Support-line plan codes: ${inboundPlanCodes.map((c) => `\`${c}\``).join(', ')}. At least one of the two is required. 403 when the account is a Shopify install (billed through Shopify only); 422 when the combination is not offered; 503 when Razorpay is not configured or unavailable.`,
      scope: 'billing:write',
      body: fromZod(SubscribeInput),
      responses: {
        '201': jsonResponse(
          'Created; send the merchant to `authorize_url`.',
          obj({
            subscription_id: str(ID_ULID),
            status: constOf('pending'),
            authorize_url: str(undefined, { format: 'uri' }),
          }),
        ),
      },
      errors: ['EngineUnavailable'],
    }),
  },
  '/v1/outcomes/{id}/disputes': {
    post: operation('post', {
      id: 'openOutcomeDispute',
      tag: 'Billing',
      summary: 'Dispute a billed outcome',
      description: `Opens a dispute on a BILLED outcome within ${String(DISPUTE_WINDOW_DAYS)} days of billing (E-62). Staff review the recording, transcript and extraction; an accepted dispute becomes a credit on the next period (the ledger is append-only, so the original charge is never edited). 422 when the outcome was not billed, was within the plan allowance, or the window has passed.`,
      scope: 'billing:write',
      params: [
        pathParam(
          'id',
          "Outcome id (`out_…`) from the intent's `outcome.outcome_id` or the `outcome.final` webhook.",
        ),
      ],
      body: documentProperties(fromZod(DisputeBody), {
        reason: 'Why you believe the outcome should not have been billed (10–2000 characters).',
      }),
      responses: {
        '201': jsonResponse('Opened.', obj({ dispute_id: str(ID_ULID), status: constOf('open') })),
      },
      errors: ['NotFound'],
    }),
  },
  '/v1/disputes': {
    get: operation('get', {
      id: 'listDisputes',
      tag: 'Billing',
      summary: 'List disputes',
      description:
        'The last 200 disputes for your account, newest first, with their resolution when decided.',
      scope: 'billing:read',
      responses: { '200': jsonResponse('Disputes.', obj({ data: arr(ref('Dispute')) })) },
    }),
  },
};

// ---- Privacy -----------------------------------------------------------------------------------------

const privacyOps: Record<string, PathItemObject> = {
  '/v1/public/dnc': {
    post: operation('post', {
      id: 'submitPublicDnc',
      tag: 'Privacy',
      summary: 'Public do-not-call request',
      description: `Backs the public /do-not-call page: anyone can ask that a number never be called by any business using Naaradh. Creates a GLOBAL, indefinite suppression across all tenants, and optionally a complaint report for an unwanted call. The response is identical whether or not the number was ever called (no oracle). Limits: ${String(DNC_REQUESTS_PER_IP_PER_HOUR)} requests per IP per hour and ${String(DNC_REQUESTS_PER_PHONE_PER_DAY)} per number per day. Erasure is deliberately NOT offered here — it is destructive and needs identity verification (POST /v1/erasure-requests by the merchant).`,
      scope: null,
      body: documentProperties(fromZod(DncBody), {
        ...PHONE_DOCS,
        report_unwanted_call: 'Also file a complaint report about an unwanted call to this number.',
      }),
      responses: {
        '202': jsonResponse(
          'Received. Takes effect everywhere within 24 hours.',
          obj({ status: constOf('received'), message: constOf(DNC_CONFIRMATION) }),
        ),
      },
    }),
  },
  '/v1/complaints': {
    post: operation('post', {
      id: 'reportComplaint',
      tag: 'Privacy',
      summary: 'File a customer complaint',
      description:
        'A merchant forwards a complaint a customer made about a call. The report is attributed to the matching call attempt by the complaints worker; a recorded complaint counts towards the automatic pause thresholds (E-05: tenant pause at 3 in 10 days) and emits `complaint.received`. A report with no matching call becomes `unattributed`.',
      scope: 'complaints:write',
      body: documentProperties(fromZod(ComplaintBody), {
        ...PHONE_DOCS,
        external_ref: 'Your reference (support ticket, order).',
        notes: 'What the customer said, in your words. Not sent to the customer.',
      }),
      responses: {
        '202': jsonResponse(
          'Report queued for attribution.',
          obj({ report_id: str(ID_ULID), status: constOf('pending') }),
        ),
      },
    }),
    get: operation('get', {
      id: 'listComplaints',
      tag: 'Privacy',
      summary: 'List complaints',
      description:
        'The last 200 attributed complaints (any source: TRAI, merchant, self-service, vendor, internal) plus your reports still pending attribution.',
      scope: 'complaints:read',
      responses: {
        '200': jsonResponse(
          'Complaints.',
          obj({
            data: arr(
              obj({
                id: str(ID_ULID),
                source: enumOf(db.complaintSource.enumValues),
                status: enumOf(db.complaintStatus.enumValues),
                attempt_id: nullable(str()),
                external_ref: nullable(str()),
                received_at: dateTime(),
              }),
            ),
            pending_reports: arr(obj({ id: str(ID_ULID), reported_at: dateTime() })),
          }),
        ),
      },
    }),
  },
  '/v1/erasure-requests': {
    post: operation('post', {
      id: 'createErasureRequest',
      tag: 'Privacy',
      summary: "Request erasure of a person's data",
      description: `Files an erasure request for a number whose owner you (the data fiduciary) have verified. The retention worker erases contact data, recordings and transcripts for that number under your account and emits \`erasure.completed\`; consent, suppression and billing records are kept as required by law. Target completion: ${String(ERASURE_COMPLETION_TARGET_DAYS)} days (\`due_at\`).`,
      scope: 'privacy:write',
      body: documentProperties(fromZod(ErasureBody), {
        ...PHONE_DOCS,
        external_ref: 'Your reference for the request.',
      }),
      responses: {
        '202': jsonResponse(
          'Filed.',
          obj({ id: str(ID_ULID), status: constOf('requested'), due_at: dateTime() }),
        ),
      },
    }),
  },
  '/v1/erasure-requests/{id}': {
    get: operation('get', {
      id: 'getErasureRequest',
      tag: 'Privacy',
      summary: 'Get an erasure request',
      description:
        'Status of an erasure request and, once completed, the report of what was erased.',
      scope: 'privacy:read',
      params: [pathParam('id', 'Erasure request id (`era_…`).')],
      responses: {
        '200': jsonResponse(
          'The request.',
          obj({
            id: str(ID_ULID),
            status: enumOf(db.erasureStatus.enumValues),
            requested_at: dateTime(),
            due_at: dateTime(),
            completed_at: nullable(dateTime()),
            report: freeForm(
              'Counts of erased rows by kind, written by the retention worker; `{}` until completed.',
            ),
          }),
        ),
      },
      errors: ['NotFound'],
    }),
  },
};

// ---- Support line ------------------------------------------------------------------------------------

const knowledgeCreateBody = KnowledgeInput.extend({
  status: z.enum(['draft', 'published']).default('draft'),
});
const knowledgeUpdateBody = KnowledgeInput.extend({
  status: z.enum(['draft', 'published', 'archived']),
});
const ticketResolveBody = z.object({ resolution: z.string().trim().min(2).max(1000) });

const KNOWLEDGE_DOCS: Readonly<Record<string, string>> = {
  title: 'Shown to the agent as the article name.',
  body: 'What the agent may say (up to 8000 characters). Sanitised: instructions to the model inside merchant text are treated as data (E-72).',
  locale: "`xx-XX`; articles are matched to the caller's locale.",
  tags: 'Up to 20 tags for retrieval.',
  status: 'Only `published` articles are used on calls.',
};

const profileBody = documentProperties(fromZod(ProfileInput), {
  greeting:
    "First utterance of every call. Must include the AI disclosure and recording disclosure in the profile's locale (invariant 7) or the request is a 422.",
  persona: 'Tone/persona hint for the agent (max 300 characters after sanitising).',
  pinned_facts: 'Short facts always available to the agent (each max 200 characters).',
  tools_enabled: `Tools the agent may use on this line: ${TOOL_NAMES.map((t) => `\`${t}\``).join(', ')}. Every tool is authorised server-side against caller identity and your settings regardless of what the model asks (invariant 18).`,
  closed_message: 'Spoken outside business hours and when the line cannot take the call.',
  fallback_forward:
    'Staff number the line forwards to when the agent cannot answer (E-92). Encrypted with the staff key; the API can store it but never read it back — responses show a masked form.',
  transfer_target_id: 'Default transfer target (must be one of yours).',
  monthly_minute_cap:
    'Inbound minutes per month before the line falls back to `fallback_forward`/the closed message.',
  agent_cancel_enabled:
    'Lets the agent cancel an unshipped COD order after the two-step confirmation (E-84). Off by default; a ticket is raised instead.',
});

const supportOps: Record<string, PathItemObject> = {
  '/v1/inbound-profiles': {
    get: operation('get', {
      id: 'listInboundProfiles',
      tag: 'Support line',
      summary: 'List inbound profiles',
      description:
        'Every profile (draft, active, disabled) with its full configuration, most recently updated first.',
      scope: 'support:read',
      responses: { '200': jsonResponse('Profiles.', obj({ data: arr(ref('ProfileView')) })) },
    }),
    post: operation('post', {
      id: 'createInboundProfile',
      tag: 'Support line',
      summary: 'Create an inbound profile',
      description:
        'Creates a profile in `draft`. The greeting must carry the AI and recording disclosure, the tools must be known, and fact limits apply — the same validator the voice runtime trusts. Activate it with POST /v1/inbound-profiles/{id}/activate once a number is attached.',
      scope: 'support:write',
      body: profileBody,
      responses: {
        '201': jsonResponse(
          'Created.',
          obj({ id: str(ID_ULID), status: constOf('draft'), version: constOf(1) }),
        ),
      },
    }),
  },
  '/v1/inbound-profiles/{id}': {
    put: operation('put', {
      id: 'replaceInboundProfile',
      tag: 'Support line',
      summary: 'Replace an inbound profile',
      description:
        'Full replacement of the configuration (send every field); the database stamps a new `version`. A null `fallback_forward` clears the stored number. Validation is the same as on create.',
      scope: 'support:write',
      params: [pathParam('id', 'Profile id (`ipr_…`).')],
      body: profileBody,
      responses: { '200': jsonResponse('The updated profile.', ref('ProfileView')) },
      errors: ['NotFound'],
    }),
  },
  '/v1/inbound-profiles/{id}/activate': {
    post: operation('post', {
      id: 'activateInboundProfile',
      tag: 'Support line',
      summary: 'Activate an inbound profile',
      description:
        'Makes the profile the one that answers. The greeting disclosure is re-validated at activation (invariant 7): a profile that lost it answers 422 and stays as it was.',
      scope: 'support:write',
      params: [pathParam('id', 'Profile id (`ipr_…`).')],
      responses: {
        '200': jsonResponse('Activated.', obj({ id: str(), status: constOf('active') })),
      },
      errors: ['NotFound', 'ValidationFailed'],
    }),
  },
  '/v1/inbound-profiles/{id}/disable': {
    post: operation('post', {
      id: 'disableInboundProfile',
      tag: 'Support line',
      summary: 'Disable an inbound profile',
      description:
        'Stops the profile from answering. Calls to its number fall back per E-92 (forward or closed message), never dead air.',
      scope: 'support:write',
      params: [pathParam('id', 'Profile id (`ipr_…`).')],
      responses: {
        '200': jsonResponse('Disabled.', obj({ id: str(), status: constOf('disabled') })),
      },
      errors: ['NotFound'],
    }),
  },
  '/v1/knowledge': {
    get: operation('get', {
      id: 'listKnowledge',
      tag: 'Support line',
      summary: 'List knowledge articles',
      description: 'Up to 500 articles in any status, most recently updated first.',
      scope: 'support:read',
      responses: {
        '200': jsonResponse(
          'Articles.',
          obj({
            data: arr(
              obj({
                id: str(ID_ULID),
                title: str(),
                body: str(),
                locale: str(),
                tags: arr(str()),
                status: enumOf(db.knowledgeStatus.enumValues),
                updated_at: dateTime(),
              }),
            ),
          }),
        ),
      },
    }),
    post: operation('post', {
      id: 'createKnowledgeArticle',
      tag: 'Support line',
      summary: 'Create a knowledge article',
      description:
        'Adds an article the agent may quote (policies, FAQs, delivery information). The knowledge base is the only source of facts the agent may state besides tool results (invariant 18). Text is sanitised before it can reach the model.',
      scope: 'support:write',
      body: documentProperties(fromZod(knowledgeCreateBody), KNOWLEDGE_DOCS),
      responses: {
        '201': jsonResponse(
          'Created.',
          obj({ id: str(ID_ULID), status: enumOf(['draft', 'published']) }),
        ),
      },
    }),
  },
  '/v1/knowledge/{id}': {
    put: operation('put', {
      id: 'replaceKnowledgeArticle',
      tag: 'Support line',
      summary: 'Replace a knowledge article',
      description:
        'Full replacement, including `status` (`archived` removes it from calls without deleting the history).',
      scope: 'support:write',
      params: [pathParam('id', 'Article id (`kna_…`).')],
      body: documentProperties(fromZod(knowledgeUpdateBody), KNOWLEDGE_DOCS),
      responses: {
        '200': jsonResponse(
          'Updated.',
          obj({ id: str(), status: enumOf(db.knowledgeStatus.enumValues) }),
        ),
      },
      errors: ['NotFound'],
    }),
  },
  '/v1/transfer-targets': {
    get: operation('get', {
      id: 'listTransferTargets',
      tag: 'Support line',
      summary: 'List transfer targets',
      description:
        'The people a call may be handed to, with a masked number, verification time, active flag and hours.',
      scope: 'support:read',
      responses: {
        '200': jsonResponse(
          'Targets.',
          obj({
            data: arr(
              obj({
                id: str(ID_ULID),
                label: str(),
                phone: str('Masked.'),
                verified_at: nullable(dateTime()),
                active: bool(),
                hours: nullable(ref('BusinessHours')),
              }),
            ),
          }),
        ),
      },
    }),
    post: operation('post', {
      id: 'createTransferTarget',
      tag: 'Support line',
      summary: 'Add a transfer target',
      description:
        'Registers a staff number the agent may transfer to (invariant 19: transfers go only to verified, active targets inside their hours; the caller never supplies a number). The number is encrypted with the staff key on receipt. Not transferable until verified — by a test call from onboarding, or by POST /v1/transfer-targets/{id}/verify.',
      scope: 'support:write',
      body: documentProperties(fromZod(TransferTargetInput), {
        ...PHONE_DOCS,
        label:
          'Shown in the dashboard and used by the agent to describe who it is transferring to.',
        hours: "When this person takes transfers; null means the profile's business hours.",
      }),
      responses: {
        '201': jsonResponse(
          'Created, unverified.',
          obj({ id: str(ID_ULID), phone: str('Masked.'), verified: constOf(false) }),
        ),
      },
    }),
  },
  '/v1/transfer-targets/{id}/verify': {
    post: operation('post', {
      id: 'verifyTransferTarget',
      tag: 'Support line',
      summary: 'Verify a transfer target by attestation',
      description: `An owner or manager attests that the number belongs to your staff. \`statement\` must be exactly: "${ATTESTATION_STATEMENT}". The attestation is written to the audit log with the attester and role.`,
      scope: 'support:write',
      params: [pathParam('id', 'Transfer target id (`ttg_…`).')],
      body: documentProperties(fromZod(AttestationInput), {
        attested_by: 'Name of the person attesting.',
        role: 'Their role in your business.',
      }),
      responses: {
        '200': jsonResponse(
          'Verified.',
          obj({ id: str(), verified_at: dateTime(), method: constOf('attestation') }),
        ),
      },
      errors: ['NotFound'],
    }),
  },
  '/v1/transfer-targets/{id}/deactivate': {
    post: operation('post', {
      id: 'deactivateTransferTarget',
      tag: 'Support line',
      summary: 'Deactivate a transfer target',
      description:
        'The agent stops transferring to this person immediately. The row is kept for the audit trail.',
      scope: 'support:write',
      params: [pathParam('id', 'Transfer target id (`ttg_…`).')],
      responses: {
        '200': jsonResponse('Deactivated.', obj({ id: str(), active: constOf(false) })),
      },
      errors: ['NotFound'],
    }),
  },
  '/v1/tickets': {
    get: operation('get', {
      id: 'listTickets',
      tag: 'Support line',
      summary: 'List tickets',
      description:
        'What the agent could not do itself — callbacks, address changes, cancellations it was not allowed to execute, refunds, complaints — up to 200, highest priority first then newest. Every ticket is also announced by the `ticket.created` webhook.',
      scope: 'tickets:read',
      params: [
        {
          name: 'status',
          in: 'query',
          required: false,
          description: 'Filter by status; omitted returns every status.',
          schema: enumOf(db.ticketStatus.enumValues),
        },
      ],
      responses: { '200': jsonResponse('Tickets.', obj({ data: arr(ref('Ticket')) })) },
    }),
  },
  '/v1/tickets/{id}/resolve': {
    post: operation('post', {
      id: 'resolveTicket',
      tag: 'Support line',
      summary: 'Resolve a ticket',
      description:
        'Marks the ticket resolved with your resolution note and emits `ticket.resolved`. Resolved tickets are final; reopening is a new ticket.',
      scope: 'tickets:write',
      params: [pathParam('id', 'Ticket id (`tkt_…`).')],
      body: documentProperties(fromZod(ticketResolveBody), {
        resolution: 'What was done (2–1000 characters).',
      }),
      responses: {
        '200': jsonResponse(
          'Resolved.',
          obj({ id: str(), status: constOf('resolved'), resolved_at: dateTime() }),
        ),
      },
      errors: ['NotFound'],
    }),
  },
  '/v1/orders/{externalId}': {
    put: operation('put', {
      id: 'upsertOrder',
      tag: 'Support line',
      summary: "Create or update an order in the agent's cache",
      description:
        "For non-Shopify merchants: the order data the inbound agent answers from (status, payment kind, tracking) and the two hashes that decide whether it may answer — the customer's phone (caller-id identity) and the delivery pincode (knowledge identity with the order number; invariant 17). No names, no addresses, no line items beyond a short summary. Stale updates are ignored: an `updated_at` older than what is stored answers `applied: false`. Send every change (fulfilment, cancellation, tracking) so the agent never states a stale status; a `cancelled_at` lets it stop a queued COD confirmation.",
      scope: 'orders:write',
      params: [
        pathParam(
          'externalId',
          'Your order id (1–200 characters), used in DELETE and in webhook payloads as `external_id`.',
        ),
      ],
      body: documentProperties(fromZod(OrderBody), {
        name: 'The order number as your customers know it (e.g. `#1042`). Matched when a caller reads it out.',
        phone: PHONE_DOCS['phone'] ?? '',
        phone_region: PHONE_DOCS['phone_region'] ?? '',
        pincode:
          'Delivery postal code; stored as a keyed hash for knowledge-based verification (E-94).',
        payment:
          '`cod` orders can be cancelled by the agent when allowed; `prepaid` cancellations always become tickets.',
        fulfillment_status:
          'Your fulfilment state as text (e.g. `unfulfilled`, `shipped`); an order that has shipped is never cancelled by the agent.',
        item_summary:
          'Up to 200 characters the agent may read back (e.g. "2 items: kurta, dupatta"). Sanitised.',
        placed_at: 'When the order was placed.',
        updated_at:
          'Source-side update time. Defaults to now. Older than the stored value → ignored.',
        tracking:
          'Courier details the agent may read out. `null` clears them; omit to leave unchanged.',
      }),
      responses: {
        '200': jsonResponse(
          'Stored (or ignored as stale).',
          obj({
            id: str('Naaradh order id (`ord_…`).'),
            applied: bool('False when a newer version was already stored.'),
          }),
        ),
      },
    }),
    delete: operation('delete', {
      id: 'eraseOrder',
      tag: 'Support line',
      summary: "Erase an order from the agent's cache",
      description:
        'Erases everything that could identify a person on the order (phone hash, pincode hash, item summary, tracking); a tombstone stays so a late update cannot re-create it (E-10/E-48). Returns how many rows were erased (0 when unknown or already erased).',
      scope: 'orders:write',
      params: [pathParam('externalId', 'Your order id.')],
      responses: { '200': jsonResponse('Erased.', obj({ erased: int() })) },
    }),
  },
};

// ---- Reference ---------------------------------------------------------------------------------------

const referenceOps: Record<string, PathItemObject> = {
  '/v1/openapi.json': {
    get: operation('get', {
      id: 'getOpenApiDocument',
      tag: 'Reference',
      summary: 'This OpenAPI document',
      description:
        'The OpenAPI 3.1 description of this API, generated from the running version. Cached for 5 minutes (`Cache-Control: public, max-age=300`).',
      scope: null,
      responses: { '200': jsonResponse('The document.', freeForm('An OpenAPI 3.1 document.')) },
    }),
  },
};

// ---------------------------------------------------------------------------------------------
// Merchant-facing webhooks (OpenAPI `webhooks`): one entry per MERCHANT_EVENTS type
// ---------------------------------------------------------------------------------------------

const WEBHOOK_DOCS: Readonly<
  Record<MerchantEventType, { summary: string; description: string; data: Schema }>
> = {
  'intent.scheduled': {
    summary: 'An intent passed the gate and will be dialled',
    description:
      'Emitted when POST /v1/intents (or a store webhook) creates an intent the gate accepted.',
    data: obj({
      intent_id: str(),
      use_case: enumOf(USE_CASES),
      external_ref: str(),
      not_before: dateTime(),
      not_after: dateTime(),
    }),
  },
  'intent.gated': {
    summary: 'An intent was refused by a compliance rule',
    description:
      'Emitted at creation when the gate refuses, and again by the dispatcher when a re-evaluation refuses for good (`final: true`). `use_case`/`external_ref` are present at creation; `title`/`final` on the dispatcher variant.',
    data: obj(
      {
        intent_id: str(),
        reason: enumOf(GATE_REASON_KEYS),
        explanation: str(),
        hint: str(),
        use_case: enumOf(USE_CASES),
        external_ref: str(),
        title: str(),
        final: constOf(true),
      },
      undefined,
      { optional: ['use_case', 'external_ref', 'title', 'final'] },
    ),
  },
  'intent.cancelled': {
    summary: 'A queued intent was cancelled',
    description:
      'Emitted for each queued intent cancelled via the API (`api:cancel`), a store event (order cancelled/paid), or an inbound call that made the outbound call redundant.',
    data: obj({
      intent_id: str(),
      reason: str('Machine reason, e.g. `api:cancel`, `confirmed_on_inbound`.'),
    }),
  },
  'call.started': {
    summary: 'A call was placed or answered',
    description:
      'Outbound: the engine accepted the dial (`intent_id`, `attempt_no`, `external_refs`). Inbound (`direction: "inbound"`): the support line answered a call on `number_id`; `intent_id` is null.',
    data: obj(
      {
        attempt_id: str(),
        intent_id: nullable(str()),
        attempt_no: int(),
        external_refs: arr(str()),
        direction: constOf('inbound'),
        number_id: str(),
      },
      undefined,
      { optional: ['attempt_no', 'external_refs', 'direction', 'number_id'] },
    ),
  },
  'call.completed': {
    summary: 'A call ended',
    description:
      'Emitted once per attempt when the engine reports the end (or reconciliation does, E-21). Outbound carries `attempt_no` and the merged `external_refs`; inbound carries `direction: "inbound"`, `minutes` (billed, rounded up per call) and a null `intent_id`. Followed by `outcome.final`.',
    data: obj(
      {
        attempt_id: str(),
        intent_id: nullable(str()),
        answered_by: nullable(AnsweredBy),
        end_reason: nullable(str()),
        duration_sec: nullable(int()),
        external_refs: arr(str()),
        attempt_no: int(),
        direction: constOf('inbound'),
        minutes: int(),
      },
      undefined,
      { optional: ['attempt_no', 'direction', 'minutes'] },
    ),
  },
  'outcome.final': {
    summary: 'The outcome of a call is final',
    description:
      'The outcome classification, its confidence, and whether it is billable (invariant 11: outbound, human answered, outcome in the billable five, not superseded; inbound is never outcome-billed). `extracted` carries the scrubbed structured extraction for outbound calls; inbound adds `tickets` (count raised on the call).',
    data: obj(
      {
        outcome_id: str(),
        attempt_id: str(),
        intent_id: nullable(str()),
        outcome: Outcome,
        confidence: num(),
        billable: bool(),
        superseded: bool(),
        external_refs: arr(str()),
        extracted: freeForm('Use-case-dependent extraction, PII-scrubbed.'),
        direction: constOf('inbound'),
        tickets: int(),
      },
      undefined,
      { optional: ['extracted', 'direction', 'tickets'] },
    ),
  },
  'suppression.created': {
    summary: 'A number was suppressed',
    description:
      'Emitted when a suppression is created via the API, from a call (the person opted out, wrong number, minor answered), or from the dashboard. `purpose` is present for API/dashboard suppressions; `external_ref` for call-originated ones (null when unknown).',
    data: obj(
      {
        suppression_id: str(),
        reason: enumOf(db.suppressionReason.enumValues),
        until: nullable(dateTime()),
        purpose: enumOf(['transactional', 'service', 'promotional', 'all']),
        external_ref: nullable(str()),
      },
      undefined,
      { optional: ['purpose', 'external_ref'] },
    ),
  },
  'ticket.created': {
    summary: 'The agent raised a ticket',
    description:
      'Something the agent could not do on the call and handed to a person: callback, address change, cancellation it was not allowed to execute, refund, complaint.',
    data: obj({
      ticket_id: str(),
      category: enumOf(db.ticketCategory.enumValues),
      callback_requested: bool(),
      attempt_id: nullable(str()),
      order_id: nullable(str()),
    }),
  },
  'ticket.resolved': {
    summary: 'A ticket was resolved',
    description: 'Emitted by POST /v1/tickets/{id}/resolve and the dashboards.',
    data: obj({ ticket_id: str(), category: enumOf(db.ticketCategory.enumValues) }),
  },
  'order.cancellation_requested': {
    summary: 'A caller asked to cancel an order',
    description:
      '`mode: "agent_cancel"`: the two-step confirmation completed and, for non-Shopify orders, YOU must cancel the order in your system (Shopify orders are cancelled by Naaradh and followed by `order.cancelled_by_agent`). `mode: "ticket"`: the agent was not allowed to cancel (shipped, prepaid, setting off, identity insufficient — `reason`) and raised `ticket_id` instead; `cancelled_intents` lists any queued COD confirmation intents that were cancelled.',
    data: obj(
      {
        order_id: str(),
        external_id: str(),
        order_name: str(),
        mode: enumOf(['agent_cancel', 'ticket']),
        attempt_id: str(),
        reason: str(),
        ticket_id: str(),
        cancelled_intents: arr(str()),
      },
      undefined,
      { optional: ['attempt_id', 'reason', 'ticket_id', 'cancelled_intents'] },
    ),
  },
  'order.cancelled_by_agent': {
    summary: 'Naaradh cancelled an order in the store',
    description:
      'The actions worker executed a confirmed cancellation against the store (Shopify). API merchants receive `order.cancellation_requested` instead.',
    data: obj({ order_id: str(), external_id: str(), order_name: str(), order_action_id: str() }),
  },
  'order.confirmed_by_caller': {
    summary: 'A caller confirmed an order on the support line',
    description:
      'A verified caller confirmed a COD order during an inbound call; any queued outbound confirmation for it was cancelled (`cancelled_intents`).',
    data: obj({
      order_id: str(),
      external_id: str(),
      order_name: str(),
      attempt_id: str(),
      cancelled_intents: arr(str()),
    }),
  },
  'inbound.call_refused': {
    summary: 'The support line could not take a call',
    description:
      'Admission refused the call (E-92) and it fell back: `forward` to your fallback number, `closed` message, or `abuse` (brief message, hang up). Never dead air.',
    data: obj({
      number_id: str(),
      reason: enumOf(INBOUND_REASON_KEYS),
      fallback: enumOf(['forward', 'closed', 'abuse']),
    }),
  },
  'complaint.received': {
    summary: 'A complaint was attributed to one of your calls',
    description:
      'Also emailed to owners and managers. Three in 10 days pauses outbound calling automatically (E-05).',
    data: obj({ complaint_id: str(), complaints_in_window: int() }),
  },
  'tenant.paused': {
    summary: 'Outbound calling was paused for your account',
    description:
      'Automatic pause after repeated complaints. Also emailed. See the dashboard banner for the next step.',
    data: obj({ reason: constOf('complaints'), complaints_in_window: int() }),
  },
  'erasure.completed': {
    summary: 'An erasure request completed',
    description:
      "The retention worker finished erasing the person's data under your account. Also emailed.",
    data: obj({ erasure_request_id: str(), source: enumOf(db.erasureSource.enumValues) }),
  },
  'billing.status_changed': {
    summary: 'Billing status changed',
    description:
      'The provider subscription changed state (active, frozen after a declined payment with `grace_until`, cancelled…). Also emailed.',
    data: obj({
      billing_status: enumOf(db.billingStatus.enumValues),
      previous: enumOf(db.billingStatus.enumValues),
      grace_until: nullable(dateTime()),
    }),
  },
  'billing.capped': {
    summary: 'The spend cap was reached',
    description:
      'Usage charges reached the cap you approved (E-61); calls are gated with `billing:capped` until the cap is raised or the period rolls over. Also emailed.',
    data: obj(
      {
        billing_status: constOf('capped'),
        previous: enumOf(db.billingStatus.enumValues),
        grace_until: nullable(dateTime()),
      },
      undefined,
      { optional: ['previous', 'grace_until'] },
    ),
  },
  'billing.approaching_cap': {
    summary: 'Usage is approaching the spend cap',
    description: 'Sent once per day while usage is near the Shopify capped amount. Also emailed.',
    data: obj({ subscription: str('Shopify subscription GID.') }),
  },
};

function webhookItem(type: MerchantEventType): PathItemObject {
  const doc = WEBHOOK_DOCS[type];
  return {
    post: {
      operationId: `webhook_${type.replace('.', '_')}`,
      tags: ['Merchant webhooks'],
      summary: doc.summary,
      description: `${doc.description}\n\nDelivered as an HTTPS POST to each endpoint registered for \`${type}\` (POST /v1/webhooks). Verify the signature before parsing; answer any 2xx quickly (10 s timeout) and process asynchronously. Dedupe on \`id\`: delivery is at-least-once.`,
      security: [],
      parameters: [
        {
          name: 'X-Naaradh-Signature',
          in: 'header',
          required: true,
          description: `\`t=<unix seconds>,v1=<hex>\` where \`v1 = HMAC-SHA256(secret, t + "." + raw_body)\`. Reject when \`|now - t| > ${String(WEBHOOK_REPLAY_WINDOW_SEC)}\` seconds or the HMAC (constant-time compare) does not match. Compute over the raw bytes, not a re-serialised object.`,
          schema: { type: 'string', pattern: '^t=\\d+,v1=[0-9a-f]{64}$' },
        },
        {
          name: 'X-Naaradh-Event-Id',
          in: 'header',
          required: true,
          description: 'Same as the body `id`; use it to dedupe before reading the body.',
          schema: { type: 'string' },
        },
        {
          name: 'User-Agent',
          in: 'header',
          required: true,
          schema: { type: 'string', const: 'Naaradh-Webhooks/1.0' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: obj({
              id: str(
                'Stable event id (typically `<subject id>:<event>`); the same id is re-sent on retries.',
              ),
              type: constOf(type),
              created_at: dateTime(),
              data: doc.data,
            }),
          },
        },
      },
      responses: {
        '2XX': {
          description:
            "Delivered. The delivery is marked `delivered` and the endpoint's failure counter resets.",
        },
        default: {
          description:
            'Anything else (non-2xx, timeout after 10 s, connection error, redirect) counts as a failure: retried after 1, 5, 30, 120 and 720 minutes — 5 attempts in all — then marked `dead` (visible at GET /v1/webhooks/deliveries and in the dashboard). 20 consecutive failures disable the endpoint and notify you.',
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

const PackageJson = z.object({ version: z.string().min(1) });

function apiVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return PackageJson.parse(raw).version;
}

const INFO_DESCRIPTION = `The public REST API of Naaradh, the two-way AI voice agent for commerce: outbound calls (COD confirmation, abandoned-checkout recovery, appointments, lead callbacks) and the inbound support line, on one compliance layer. Every request is checked in this order: API key → scope → schema → your tenant's row-level security context. The API never dials and never reads a phone number back; it hands intents to the same pipeline the Shopify app uses.

## Authentication

\`Authorization: Bearer <key>\`.

- **Secret keys** \`nrd_live_…\` / \`nrd_test_…\` (32 base62 characters after the prefix): for your servers. Scoped per key, with an optional IP allow-list and a per-key daily intent cap (E-70). Never ship one in a browser or an app.
- **Public site keys** \`nrd_pk_…\`: for the website snippet (\`naaradh.js\`, SPEC §9.2). Usable only for \`POST /v1/intents\` with \`use_case: lead_callback\`; the request's \`Origin\` must be on the key's domain list (subdomains included). CORS is answered only for that route, only for public keys, with no credentials. Secret keys never receive CORS headers.

Keys are stored hashed; a lost key is replaced, not recovered.

## Scopes

Each operation lists the scope it needs. Scopes: \`intents:create\`, \`intents:read\`, \`consents:write\`, \`suppressions:write\`, \`calls:read\`, \`webhooks:read\`, \`webhooks:write\`, \`billing:read\`, \`billing:write\`, \`complaints:read\`, \`complaints:write\`, \`privacy:read\`, \`privacy:write\`, \`support:read\`, \`support:write\`, \`tickets:read\`, \`tickets:write\`, \`orders:write\`. Missing scope → 403 \`FORBIDDEN\`.

## Rate limits

Per secret key: 120 requests per minute (a fixed one-minute window). Per public key: 10 requests/minute per client IP. Exceeding the limit → 429 with \`Retry-After\` and the flat \`RateLimitError\` body. Intent creation additionally counts against the key's daily cap (default 5000/day, UTC) → 429 with the \`Error\` envelope and \`Retry-After: 3600\`.

## Idempotency

Send \`Idempotency-Key\` on POST requests you might retry. Keys are remembered for 24 hours per tenant; a replay with the same key and the same request returns the original response with \`Idempotent-Replay: true\`; the same key with a different request is a 422. Intent creation is also idempotent on (\`external_ref\`, \`use_case\`) even without the header.

## Errors

Every error is JSON: \`{"error": {"code", "message", "details?", "request_id"}}\`; \`code\` is one of ${ERROR_CODES.map((c) => `\`${c}\``).join(', ')} (see the Error schema for the status each maps to). Validation failures list the offending paths in \`details\`. The only exception is the per-minute rate limiter, whose body is flat (\`RateLimitError\`).

## Phone numbers and PII

Send numbers in any format with \`phone_region\` for numbers without a country code. Naaradh normalises to E.164, keeps a keyed hash for lookups and an encrypted copy readable only by the dialler; responses and webhooks carry a masked form at most. Names are used as script variables only. Recording access is audited.

## Requests

JSON bodies up to 256 KiB (\`Content-Type: application/json\`). Timestamps are ISO 8601 with offset; money is integer minor units with an ISO 4217 currency alongside; ids are prefixed ULIDs. The \`request_id\` in every error (from \`x-cloud-trace-context\` when you send one) is what support needs.`;

export function buildOpenApiDocument(): OpenAPIObject {
  const webhooks: Record<string, PathItemObject> = {};
  for (const type of MERCHANT_EVENTS) webhooks[type] = webhookItem(type);

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Naaradh API',
      version: apiVersion(),
      summary:
        'Two-way AI voice agent for commerce — outbound call intents and the inbound support line.',
      description: INFO_DESCRIPTION,
      contact: { name: 'Naaradh', url: 'https://naaradh.com' },
    },
    servers: [
      { url: 'https://api.naaradh.com', description: 'Production' },
      { url: 'http://localhost:3001', description: 'Local development (apps/api default PORT)' },
    ],
    tags: TAGS,
    security: [{ secretKey: [] }],
    paths: {
      ...intentOps,
      ...consentOps,
      ...callOps,
      ...webhookOps,
      ...billingOps,
      ...privacyOps,
      ...supportOps,
      ...referenceOps,
    },
    webhooks,
    components: {
      securitySchemes: {
        secretKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'nrd_live_… / nrd_test_…',
          description:
            'Secret API key. The scope names listed on each operation are what the key must carry.',
        },
        publicSiteKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'nrd_pk_…',
          description:
            'Public site key for browsers: `POST /v1/intents` with `use_case: lead_callback` only, from an allow-listed Origin, 10 requests/minute per IP.',
        },
      },
      schemas: componentSchemas,
      responses: componentResponses,
      parameters: componentParameters,
      headers: componentHeaders,
    },
  };
}

/** Deterministic JSON: keys sorted recursively, arrays in order, 2-space indent, trailing newline. */
export function serializeOpenApiDocument(doc: OpenAPIObject): string {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  return value;
}
