import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for small secrets at rest (ADR-0007: Shopify access tokens in `shopify_sessions`).
 * The additional authenticated data binds a ciphertext to the row it belongs to — a sealed
 * token copied onto another shop's row fails to open instead of authenticating as that shop.
 *
 * Keys are 32 random bytes, configured base64-encoded (`SHOPIFY_TOKEN_KEY`). A `kid` travels
 * with every sealed value so rotation is a re-encryption job, never a guess.
 */
export interface Sealed {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly kid: number;
}

export function parseSecretKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('secret key must be 32 bytes, base64-encoded');
  return key;
}

export function seal(key: Buffer, kid: number, plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), kid };
}

/** Throws when the key, the AAD or any byte of the sealed value is wrong. */
export function open(key: Buffer, sealed: Omit<Sealed, 'kid'>, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}
