import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Invariant 8 at the logging layer. This list is THE list: every service passes it to pino
 * (apps import `REDACT_PATHS`), and `naaradh/no-pii-in-logs` refuses the obvious cases at
 * lint time. Extend it in the same PR that adds any field which can carry PII (AGENTS §11).
 *
 * Paths use pino's wildcard syntax: `*.phone` matches a `phone` key one level down in any
 * object logged; the bracket forms match header names with dashes.
 */
export const REDACT_PATHS: readonly string[] = [
  // credentials
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-shopify-hmac-sha256"]',
  'req.headers["x-naaradh-signature"]',
  'req.headers["x-api-key"]',
  '*.api_key',
  '*.apiKey',
  '*.secret',
  '*.password',
  '*.token',
  // dialable numbers and people
  '*.phone',
  '*.phone_e164',
  '*.phoneE164',
  '*.to',
  '*.from',
  '*.to_e164',
  '*.from_e164',
  '*.msisdn',
  '*.mobile',
  '*.customer_name',
  '*.customerName',
  '*.name',
  '*.email',
  '*.address',
  '*.shipping_address',
  '*.billing_address',
  // call content
  '*.transcript',
  '*.transcript_text',
  '*.recording_url',
  '*.recordingUrl',
  '*.variables',
  '*.extracted',
  '*.payload',
  // nested one level deeper (e.g. { order: { customer: { phone } } })
  '*.*.phone',
  '*.*.email',
  '*.*.name',
  '*.*.address',
  '*.*.*.phone',
  '*.*.*.email',
];

export interface LoggerBindings {
  service: string;
  version?: string;
  tenant_id?: string;
  intent_id?: string;
  attempt_id?: string;
  engine?: string;
  request_id?: string;
}

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Pretty output for `pnpm dev`; JSON (Cloud Logging) otherwise. */
  pretty?: boolean;
}

/**
 * Structured JSON logger with the shared redaction list. Cloud Logging reads `severity`, so
 * levels are mapped to its names.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: { service: options.service },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    formatters: {
      level(label) {
        return { severity: SEVERITY[label] ?? label.toUpperCase(), level: label };
      },
    },
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (options.pretty === true) {
    base.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' },
    };
  }
  return pino(base);
}

const SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * Pino options for Fastify's built-in logger (api, hooks, voice): same redaction as
 * createLogger, plus a Cloud Logging `severity` so error-level request logs are ERROR in
 * Cloud Logging instead of DEFAULT. The numeric pino `level` is kept for existing filters.
 */
export function fastifyLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    formatters: {
      level(label, number) {
        return { severity: SEVERITY[label] ?? label.toUpperCase(), level: number };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export type { Logger };
