import {
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  constants as cryptoConstants,
} from 'node:crypto';
import {
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumberType,
} from 'libphonenumber-js/max';

/**
 * Everything about a phone number, in one place, so the rest of the codebase never holds a
 * dialable number longer than it must (invariant 8).
 *
 *   normalizePhone   input → E.164 + region + type, or a reason it was rejected
 *   dialRejectReason gate step 4 policy: no premium/shared-cost/short codes/emergency numbers
 *   hashPhone        HMAC-SHA256 for every lookup and join
 *   maskPhone        what the dashboard shows
 *   encryptPhone     RSA-OAEP with the PUBLIC key — anything can encrypt
 *   decryptPhone     RSA-OAEP with the PRIVATE key — only the dispatcher and results-consumer
 */

export type PhoneRegion = CountryCode;

export interface ParsedPhone {
  readonly e164: string;
  /** ISO country the number belongs to. THIS picks the rules, never the merchant's country. */
  readonly region: PhoneRegion;
  /** Coarse type for the gate. 'unknown' when metadata has no opinion (+91 always: see below). */
  readonly type: 'mobile' | 'landline' | 'voip' | 'unknown';
  readonly rawType: PhoneNumberType | undefined;
  /**
   * libphonenumber believes this exact number is in an allocated range. Informational, NOT a
   * gate criterion: metadata lags regulators, and reserved test ranges (Ofcom's 07700 900xxx)
   * are deliberately marked unallocated. Dialling an unallocated number harms nobody; it is a
   * cost signal for the dashboard, not a compliance rule.
   */
  readonly allocated: boolean;
}

export type PhoneRejectReason =
  | 'unparseable'
  | 'not_e164'
  | 'impossible_for_region'
  | 'unknown_region'
  | 'india_not_mobile'
  | 'premium_rate'
  | 'shared_cost'
  | 'short_code'
  | 'emergency'
  | 'pager_or_uan';

export type NormalizeResult =
  | { ok: true; phone: ParsedPhone }
  | { ok: false; reason: PhoneRejectReason };

/** SPEC §4.1 / E-26: Indian mobiles are exactly +91 followed by a 6–9 and nine more digits. */
export const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Primary country per calling code, for numbers libphonenumber cannot pin to one country
 * (shared codes like +44 GB/GG/IM/JE, +1 NANP, and any range it deems unallocated).
 */
const PRIMARY_REGION: Readonly<Record<string, PhoneRegion>> = {
  '1': 'US',
  '91': 'IN',
  '44': 'GB',
  '353': 'IE',
  '49': 'DE',
  '33': 'FR',
  '34': 'ES',
  '39': 'IT',
  '31': 'NL',
  '32': 'BE',
  '41': 'CH',
  '43': 'AT',
  '46': 'SE',
  '45': 'DK',
  '47': 'NO',
  '358': 'FI',
  '351': 'PT',
  '48': 'PL',
  '61': 'AU',
  '64': 'NZ',
  '65': 'SG',
  '971': 'AE',
};

/**
 * Emergency and public-service short codes we must never dial (universal rule 9), compared
 * against the NATIONAL significant number. India per DoT's national short-code list.
 */
const EMERGENCY_NUMBERS: Readonly<Record<string, readonly string[]>> = {
  IN: ['100', '101', '102', '108', '112', '1091', '1098', '181', '1930'],
  US: ['911', '988', '311', '211'],
  CA: ['911', '988'],
  GB: ['999', '112', '111', '101', '105'],
  IE: ['999', '112'],
  DE: ['110', '112', '116117'],
  FR: ['15', '17', '18', '112', '114', '115'],
  ES: ['112', '091', '092'],
  IT: ['112', '113', '115', '118'],
  NL: ['112'],
  AU: ['000', '112', '106'],
};

const NEVER_DIAL_TYPES: ReadonlySet<PhoneNumberType> = new Set(['PAGER', 'UAN', 'VOICEMAIL']);

/**
 * Parse anything a merchant might send ("98765 43210", "+91-98765-43210", "0044 7700 …") into
 * E.164. `defaultRegion` is the merchant's country and is used only to interpret input with
 * no country code; the RESULT's region is what the gate uses (invariant 2).
 *
 * India is special-cased deliberately: the spec's rule `^\+91[6-9]\d{9}$` is authoritative
 * for validity (it is what excludes landlines and short codes), and type for +91 comes from
 * the number-type lookup provider at gate step 4, not from metadata.
 */
export function normalizePhone(input: string, defaultRegion?: PhoneRegion): NormalizeResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'unparseable' };

  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);
  if (parsed === undefined) return { ok: false, reason: 'unparseable' };

  const e164 = parsed.number;
  if (!E164.test(e164)) return { ok: false, reason: 'not_e164' };

  if (parsed.countryCallingCode === '91') {
    if (!INDIAN_MOBILE.test(e164)) return { ok: false, reason: 'india_not_mobile' };
    return {
      ok: true,
      phone: {
        e164,
        region: 'IN',
        type: 'mobile',
        rawType: parsed.getType(),
        allocated: parsed.isValid(),
      },
    };
  }

  // Structural check only (length/shape for the region). See `allocated` for why not isValid().
  if (!parsed.isPossible()) return { ok: false, reason: 'impossible_for_region' };

  const region = parsed.country ?? PRIMARY_REGION[parsed.countryCallingCode];
  if (region === undefined) return { ok: false, reason: 'unknown_region' };

  const rawType = parsed.getType();
  return {
    ok: true,
    phone: { e164, region, type: mapType(rawType), rawType, allocated: parsed.isValid() },
  };
}

function mapType(t: PhoneNumberType | undefined): ParsedPhone['type'] {
  if (t === 'MOBILE') return 'mobile';
  if (t === 'FIXED_LINE') return 'landline';
  if (t === 'VOIP') return 'voip';
  return 'unknown';
}

/**
 * Gate step 4 policy (E-26, E-27, universal rule 9). Returns the reason a number may not be
 * dialled, or null if it may. Landline handling for +91 is the caller's job via the
 * number-type lookup — this function knows only what the digits say.
 */
export function dialRejectReason(phone: ParsedPhone): PhoneRejectReason | null {
  const national = nationalNumber(phone.e164);
  const emergency = EMERGENCY_NUMBERS[phone.region] ?? [];
  if (emergency.includes(national)) return 'emergency';
  // Anything shorter than 7 national digits is a short code somewhere.
  if (national.length < 7) return 'short_code';
  if (phone.rawType === 'PREMIUM_RATE') return 'premium_rate';
  if (phone.rawType === 'SHARED_COST') return 'shared_cost';
  if (phone.rawType !== undefined && NEVER_DIAL_TYPES.has(phone.rawType)) return 'pager_or_uan';
  return null;
}

export function isDialable(phone: ParsedPhone): boolean {
  return dialRejectReason(phone) === null;
}

/** Country calling code length: longest known prefix wins (3, then 2, then 1). */
function countryCallingCodeLength(e164: string): number {
  const digits = e164.slice(1);
  for (const len of [3, 2, 1]) {
    if (PRIMARY_REGION[digits.slice(0, len)] !== undefined) return len;
  }
  // Unknown code: libphonenumber can still tell us.
  const parsed = parsePhoneNumberFromString(e164);
  return parsed?.countryCallingCode.length ?? 2;
}

function nationalNumber(e164: string): string {
  return e164.slice(1 + countryCallingCodeLength(e164));
}

/** HMAC-SHA256 hex. Same key per environment; rotation is a re-hash migration, not a config flip. */
export function hashPhone(e164: string, key: string): string {
  if (!E164.test(e164)) throw new TypeError('hashPhone expects E.164');
  return createHmac('sha256', key).update(e164).digest('hex');
}

/**
 * "+916000000001" → "+91 60xxx xx001". Country code, first two national digits, last three.
 * Enough to recognise a number you already know; not enough to dial it.
 */
export function maskPhone(e164: string): string {
  if (!E164.test(e164)) throw new TypeError('maskPhone expects E.164');
  const ccLen = countryCallingCodeLength(e164);
  const cc = e164.slice(0, 1 + ccLen);
  const national = e164.slice(1 + ccLen);
  const head = national.slice(0, 2);
  const tail = national.slice(-3);
  const hidden = 'x'.repeat(Math.max(0, national.length - 5));
  const body = `${head}${hidden}${tail}`;
  return `${cc} ${body.slice(0, 5)} ${body.slice(5)}`.trim();
}

// ---------------------------------------------------------------------------
// Encryption at rest for the dialable number. Asymmetric on purpose (AGENTS §4): the api and
// the intents-consumer hold only the PUBLIC key and can therefore never read numbers back
// out of the database; the private key is mounted only into the dispatcher and the
// results-consumer. A database export plus an api compromise yields no phone numbers.
// ---------------------------------------------------------------------------

export interface EncryptedPhone {
  readonly ciphertext: Buffer;
  /** Key version the ciphertext was made with, stored beside it for rotation. */
  readonly kid: number;
}

const OAEP = { padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' } as const;

export function encryptPhone(e164: string, publicKeyPem: string, kid: number): EncryptedPhone {
  if (!E164.test(e164)) throw new TypeError('encryptPhone expects E.164');
  const ciphertext = publicEncrypt({ key: publicKeyPem, ...OAEP }, Buffer.from(e164, 'utf8'));
  return { ciphertext, kid };
}

export function decryptPhone(ciphertext: Buffer, privateKeyPem: string): string {
  const plain = privateDecrypt({ key: privateKeyPem, ...OAEP }, ciphertext).toString('utf8');
  if (!E164.test(plain)) throw new Error('decrypted value is not an E.164 number');
  return plain;
}

/** Dev/test only. Production keys are generated in KMS and never touch a laptop. */
export function generatePhoneKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}
