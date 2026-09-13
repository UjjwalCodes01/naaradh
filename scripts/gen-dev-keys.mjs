#!/usr/bin/env node
/**
 * `pnpm keys:dev` — prints a fresh PHONE_HASH_KEY and an RSA-OAEP key pair for LOCAL use.
 *
 * Prints, never writes: paste into .env.local yourself. Production keys are generated in
 * KMS and mounted from Secret Manager; nothing produced here may ever reach a deployed
 * environment.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const hashKey = randomBytes(32).toString('base64');
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const staff = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const oneLine = (pem) => JSON.stringify(pem); // quotes + \n escapes, dotenv-compatible

process.stdout.write(
  [
    '# Local development keys — paste into .env.local (git-ignored). Do not reuse anywhere.',
    `PHONE_HASH_KEY=${hashKey}`,
    `PHONE_ENC_PUBLIC_KEY=${oneLine(publicKey)}`,
    `PHONE_ENC_PRIVATE_KEY=${oneLine(privateKey)}`,
    'PHONE_ENC_KID=1',
    '# Staff key pair: transfer-target / fallback numbers. Voice holds the private half.',
    `STAFF_ENC_PUBLIC_KEY=${oneLine(staff.publicKey)}`,
    `STAFF_ENC_PRIVATE_KEY=${oneLine(staff.privateKey)}`,
    'STAFF_ENC_KID=1',
    `ENGINE_WEBHOOK_KEY=${randomBytes(32).toString('hex')}`,
    `SHOPIFY_API_SECRET=${randomBytes(24).toString('hex')}`,
    '',
  ].join('\n'),
);
