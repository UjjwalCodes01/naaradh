import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import type { Db } from '@naaradh/db';
import {
  NaaradhError,
  hashPhone,
  isNaaradhError,
  normalizePhone,
  type PhoneRegion,
} from '@naaradh/shared';
import { page, type Raw } from './html.js';

/** Shared plumbing for every console route module: deps, flash messages, forms, errors. */

export interface ConsoleDeps {
  readonly db: Db;
  readonly redis: Redis;
  readonly clock: () => Date;
  readonly hashKey: string;
  readonly origin: string;
  /** Resolves the verified staff email for a request, or null (→ 403). */
  readonly authenticate: (request: FastifyRequest) => Promise<string | null>;
  /** Transcript reader for dispute evidence; null where no bucket is configured. */
  readonly readTranscript: ((uri: string) => Promise<{ role: string; text: string }[]>) | null;
  readonly logLevel?: string;
  /** TRUST_PROXY_HOPS — trailing X-Forwarded-For entries that are ours. */
  readonly trustProxyHops?: number;
  /** Where merchants sign in — shown after a merchant is created (default: local dashboard). */
  readonly dashboardUrl?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: string;
  }
}

const FLASH = 'console_flash';

export function readFlash(request: FastifyRequest): { ok: boolean; message: string } | undefined {
  const cookie = request.headers.cookie ?? '';
  const m = new RegExp(`(?:^|;\\s*)${FLASH}=([^;]+)`).exec(cookie);
  if (m?.[1] === undefined) return undefined;
  try {
    const v = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as {
      ok?: unknown;
      message?: unknown;
    };
    return typeof v.message === 'string'
      ? { ok: v.ok === true, message: v.message.slice(0, 300) }
      : undefined;
  } catch {
    return undefined;
  }
}

export function done(reply: FastifyReply, to: string, ok: boolean, message: string): FastifyReply {
  const value = Buffer.from(JSON.stringify({ ok, message })).toString('base64url');
  return reply
    .header(
      'set-cookie',
      `${FLASH}=${value}; Path=/; Max-Age=15; HttpOnly; SameSite=Strict; Secure`,
    )
    .redirect(to, 303);
}

export function body(request: FastifyRequest): Record<string, string> {
  const b = request.body;
  return b !== null && typeof b === 'object' ? (b as Record<string, string>) : {};
}

export const staffActor = (email: string) => `staff:${email}`;

export const Reason = z.string().trim().min(10, 'give a reason of at least 10 characters').max(500);

export function phoneHashOf(hashKey: string, phone: string, region: string): string {
  const parsed = normalizePhone(phone, (region || 'IN').toUpperCase() as PhoneRegion);
  if (!parsed.ok) throw new NaaradhError('VALIDATION_FAILED', 'not a valid phone number');
  return hashPhone(parsed.phone.e164, hashKey);
}

export function problem(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((i) => i.message).join('; ');
  if (isNaaradhError(error)) return error.message;
  if (error instanceof TypeError) return error.message;
  return 'failed — see logs';
}

export function render(
  reply: FastifyReply,
  request: FastifyRequest,
  title: string,
  content: Raw,
): FastifyReply {
  return reply
    .header('set-cookie', `${FLASH}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`)
    .type('text/html; charset=utf-8')
    .send(page(title, request.staff ?? '', content, readFlash(request)));
}
