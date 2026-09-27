import type { SsoRefusal, SsoSecretKey } from '@naaradh/pipeline';
import { env } from './env';

/**
 * Dashboard single sign-on (P7-ENT-1): the pieces the start and callback routes share.
 * `kid` 1 is the only key today; rotation adds kid 2 and a re-seal job, never a guess.
 */
export function ssoKey(): SsoSecretKey | null {
  const raw = env().SSO_SECRET_KEY;
  return raw === undefined ? null : { key: Buffer.from(raw, 'base64'), kid: 1 };
}

/** Holds the pending sign-in's `state` so a callback can be bound to the browser that started it. */
export function ssoCookieName(): string {
  return env().NODE_ENV === 'production' ? '__Host-naaradh_sso' : 'naaradh_sso';
}

export function ssoRedirectUri(): string {
  return `${env().APP_URL}/auth/sso/callback`;
}

export const ssoStateKey = (stateHash: string) => `sso:state:${stateHash}`;

/** What a person sees on /login after a refused sign-in — never the provider's own words. */
export const SSO_MESSAGES: Readonly<Record<SsoRefusal | 'unavailable', string>> = {
  expired: 'That sign-in took too long or was already used. Start again.',
  provider_unreachable: "Your organisation's sign-in did not answer. Try again in a minute.",
  provider_misconfigured:
    "Your organisation's single sign-on is not set up correctly. Ask your Naaradh owner to check it.",
  provider_refused: "Your organisation's sign-in did not let you through.",
  token_invalid: 'The sign-in could not be verified. Start again.',
  email_unverified:
    'Your identity provider did not confirm your email address. Ask your IT team to send email_verified.',
  domain_not_allowed:
    'That email address is not one this account allows for single sign-on. Ask your Naaradh owner.',
  no_account:
    'Your organisation signed you in, but you do not have access to this Naaradh account. Ask an owner to invite you.',
  unavailable: 'Single sign-on is not available right now. Use the email link instead.',
};
