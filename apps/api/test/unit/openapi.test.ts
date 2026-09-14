import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildOpenApiDocument,
  serializeOpenApiDocument,
  type HttpMethod,
  type OpenAPIObject,
} from '../../src/openapi.js';

/**
 * The OpenAPI document must describe exactly the routes the server registers (AGENTS §12
 * "OpenAPI drift check"): a route added without documentation fails here, and so does a
 * documented route that no longer exists. Plus the structural rules every operation follows.
 */

const ROUTES_DIR = fileURLToPath(new URL('../../src/routes/', import.meta.url));
// `app.post('/v1/x'`, `app.post<{…}>(\n  '/v1/x'`, and template paths built in a loop
// (`\`/v1/inbound-profiles/:id/${path}\`` with `['activate', …]` tuples).
const ROUTE_RE = /app\.(get|post|put|delete)(?:<[^(]*>)?\(\s*(['`])(\/v1\/[^'`]*)\2/g;
const LOOP_KEY_RE = /\['([a-z_]+)', '[a-z_]+'\] as const|\['([a-z_]+)', '[a-z_]+'\],/g;

function registeredRoutes(): Set<string> {
  const out = new Set<string>();
  const files = [
    ...readdirSync(ROUTES_DIR).map((f) => join(ROUTES_DIR, f)),
    // /v1/openapi.json itself is registered in server.ts.
    fileURLToPath(new URL('../../src/server.ts', import.meta.url)),
  ];
  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(file, 'utf8');
    const loopKeys = [...src.matchAll(LOOP_KEY_RE)].map((m) => m[1] ?? m[2] ?? '');
    for (const m of src.matchAll(ROUTE_RE)) {
      const method = (m[1] ?? '').toUpperCase();
      // Fastify `:param` → OpenAPI `{param}`.
      const path = (m[3] ?? '').replaceAll(/:([A-Za-z_]+)/g, '{$1}');
      if (path.includes('${path}'))
        for (const key of loopKeys) out.add(`${method} ${path.replace('${path}', key)}`);
      else out.add(`${method} ${path}`);
    }
  }
  return out;
}

function documentedRoutes(doc: OpenAPIObject): Set<string> {
  const out = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths))
    for (const method of Object.keys(item) as HttpMethod[])
      out.add(`${method.toUpperCase()} ${path}`);
  return out;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
  } else if (value !== null && typeof value === 'object') {
    visit(value as Record<string, unknown>);
    for (const v of Object.values(value as Record<string, unknown>)) walk(v, visit);
  }
}

const doc = buildOpenApiDocument();

describe('openapi document', () => {
  it('documents every registered /v1 route and nothing else', () => {
    const registered = registeredRoutes();
    const documented = documentedRoutes(doc);
    expect([...documented].sort()).toEqual([...registered].sort());
    expect(registered.size).toBeGreaterThan(15);
  });

  it('is OpenAPI 3.1 with the merchant webhooks described', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.webhooks)).toEqual(
      expect.arrayContaining(['call.completed', 'outcome.final', 'intent.gated']),
    );
  });

  it('every operation has an id, a tag, a success response and error responses', () => {
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item)) {
        const codes = Object.keys(op.responses);
        expect(op.operationId, `${method} ${path}`).toMatch(/^[a-z][A-Za-z]+$/);
        expect(op.tags.length, `${method} ${path}`).toBe(1);
        expect(
          codes.some((c) => c.startsWith('2')),
          `${method} ${path} success`,
        ).toBe(true);
        expect(codes, `${method} ${path} errors`).toEqual(expect.arrayContaining(['429', '500']));
        if ((op.security ?? []).length > 0)
          expect(codes, `${method} ${path} auth errors`).toEqual(
            expect.arrayContaining(['401', '403']),
          );
      }
  });

  it('every $ref resolves inside the document and no schema is an unresolved zod reference', () => {
    const refs: string[] = [];
    walk(doc, (node) => {
      if (typeof node['$ref'] === 'string') refs.push(node['$ref']);
    });
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/'), ref).toBe(true);
      const [, , kind, name] = ref.split('/');
      const bucket = (doc.components as Record<string, Record<string, unknown>>)[kind ?? ''];
      expect(bucket?.[name ?? ''], ref).toBeDefined();
    }
  });

  it('never contains a phone number or an example that looks like one outside the fake ranges', () => {
    const text = serializeOpenApiDocument(doc);
    const numbers = text.match(/\+\d[\d ]{8,}/g) ?? [];
    for (const n of numbers)
      expect(n.replaceAll(' ', ''), n).toMatch(/^\+(916000000|121255501|447700900)/);
  });

  it('serialises deterministically', () => {
    expect(serializeOpenApiDocument(buildOpenApiDocument())).toBe(serializeOpenApiDocument(doc));
    expect(serializeOpenApiDocument(doc).endsWith('\n')).toBe(true);
  });
});
