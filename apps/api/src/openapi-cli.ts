import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, serializeOpenApiDocument } from './openapi.js';

/**
 * `pnpm openapi` → docs/api/openapi.json. Deterministic output (sorted keys), so CI can fail
 * on drift: `pnpm openapi && git diff --exit-code -- docs/api/openapi.json`.
 */
const target = fileURLToPath(new URL('../../../docs/api/openapi.json', import.meta.url));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, serializeOpenApiDocument(buildOpenApiDocument()));
process.stdout.write(`wrote ${target}\n`);
