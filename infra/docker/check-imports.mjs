// Build-time guard for the service images (*/Dockerfile).
//
// The tsup bundles inline every `@naaradh/*` workspace package but leave third-party packages as
// runtime imports. Those imports are resolved from /app/node_modules, which is a *flattened*
// production install. If a workspace package gains a dependency that is not hoisted there, the
// image would only fail when that code path first runs — for a dynamic import (Secret Manager,
// GCS) possibly mid-call in production. This script resolves every bare specifier found in
// dist/*.js from the image's own root and fails the build if any is missing.
//
// Usage (inside the image, cwd = /app): node check-imports.mjs dist
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist';
const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));

// Anchored to esbuild's output shape (one statement per line, multi-line import lists end in
// `} from "x";`) so that SQL text such as `select … from "orders"` is not mistaken for an import.
const patterns = [
  /^(?:import|export|\})[^\n'"]*?\bfrom\s*["']([^"']+)["'];?$/gm,
  /^import\s*["']([^"']+)["'];?$/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const specifiers = new Set();
for (const file of files) {
  const source = readFileSync(join(dir, file), 'utf8');
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const spec = match[1];
      if (spec === undefined || spec.startsWith('.') || spec.startsWith('/')) continue;
      if (spec.startsWith('node:') || isBuiltin(spec)) continue;
      specifiers.add(spec);
    }
  }
}

const missing = [];
for (const spec of [...specifiers].sort()) {
  try {
    import.meta.resolve(spec);
  } catch {
    missing.push(spec);
  }
}

if (missing.some((s) => s.startsWith('@naaradh/'))) {
  console.error('workspace packages must be bundled (tsup noExternal), found runtime imports:');
}
if (missing.length > 0) {
  console.error(`unresolvable runtime imports in ${dir}: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(
  `${String(specifiers.size)} runtime imports resolve: ${[...specifiers].sort().join(', ')}`,
);
