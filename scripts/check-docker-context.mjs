#!/usr/bin/env node
/**
 * Every deployed service is bundled inside its image from the build context, and that context
 * is the repo root filtered by `.dockerignore` — which drops `test/`, `docs/`, `tools/`,
 * `scripts/`, most of `infra/`, and every build output. A service whose source imports a file
 * that `.dockerignore` removes builds perfectly on a developer's machine and fails inside
 * `docker build`, twenty minutes into CI.
 *
 * This walks the static import graph of each service from its entrypoint, resolves every
 * relative and `@naaradh/*` specifier the way the bundler does, and fails if a reachable file
 * is missing from the build context. It is deliberately not a type checker: it only answers
 * "will this file be in the image?".
 *
 * Run: pnpm lint:context
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The bundled entrypoints. The four Fastify services and the console are bundled by tsup from
 * one entry; `web` (Next.js) and `shopify` (React Router) bundle every route, so their whole
 * source tree is a root.
 */
const ENTRYPOINTS = [
  'api/src/index.ts',
  'hooks/src/index.ts',
  'voice/src/index.ts',
  'workers/src/index.ts',
  'console/src/index.ts',
  'infra/docker/migrate-job.mjs',
  'web/src',
  'shopify/app',
];

// ---------------------------------------------------------------------------------------------
// .dockerignore

/**
 * One `.dockerignore` line → a predicate on a repo-relative path.
 *
 * Docker's rules, not gitignore's: every pattern is anchored at the context root (so `tools`
 * excludes only the root `tools/`, never `voice/src/tools/`), a leading double-star segment
 * matches any number of leading directories including none, and matching a directory excludes
 * everything under it.
 */
function compile(pattern) {
  const negated = pattern.startsWith('!');
  const body = (negated ? pattern.slice(1) : pattern).replace(/^\//, '').replace(/\/$/, '');
  const anyDepth = body.startsWith('**/');
  const segments = (anyDepth ? body.slice(3) : body).split('/').map((segment) =>
    segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replaceAll('\u0000', '.*'),
  );
  const regex = new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${segments.join('/')}(?:/.*)?$`);
  return { negated, pattern, test: (path) => regex.test(path) };
}

const RULES = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map(compile);

/** The last matching rule wins, exactly as Docker resolves it. */
function excludedBy(repoPath) {
  let verdict = null;
  for (const rule of RULES) {
    if (rule.test(repoPath)) verdict = rule.negated ? null : rule.pattern;
  }
  return verdict;
}

// ---------------------------------------------------------------------------------------------
// workspace packages

/** name → { dir, exports } for every @naaradh/* workspace package. */
const WORKSPACE = new Map();
for (const dir of readdirSync(ROOT)) {
  const candidates = [dir, ...(dir === 'engines' ? readdirSync(join(ROOT, dir)) : [])].map((d) =>
    d === dir ? dir : `${dir}/${d}`,
  );
  for (const candidate of candidates) {
    const manifest = join(ROOT, candidate, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@naaradh/')) {
      WORKSPACE.set(pkg.name, { dir: candidate, exports: pkg.exports ?? {}, main: pkg.main });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// resolution

const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.js'];

function resolveFile(absolute) {
  for (const extension of EXTENSIONS) {
    const candidate = absolute + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // TypeScript ESM imports carry the .js extension of the emitted file.
  if (/\.js$/.test(absolute)) return resolveFile(absolute.replace(/\.js$/, ''));
  return null;
}

function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith('.')) {
    return { file: resolveFile(resolve(dirname(fromFile), specifier)), workspace: true };
  }
  if (!specifier.startsWith('@naaradh/')) return { file: null, workspace: false };
  const [scope, name, ...rest] = specifier.split('/');
  const pkg = WORKSPACE.get(`${scope}/${name}`);
  if (!pkg) return { file: null, workspace: false };
  const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`;
  const target = pkg.exports[subpath] ?? (subpath === '.' ? pkg.main : undefined);
  if (typeof target !== 'string') return { file: null, workspace: false };
  return { file: resolveFile(join(ROOT, pkg.dir, target)), workspace: true };
}

const IMPORT_RE =
  /(?:^|[\s;}])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}(])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;

function specifiersIn(file) {
  const source = readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) found.add(specifier);
  }
  return found;
}

function sourceFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

const problems = [];
const seen = new Set();

function walk(file, chain) {
  if (seen.has(file)) return;
  seen.add(file);
  for (const specifier of specifiersIn(file)) {
    const { file: target, workspace } = resolveSpecifier(specifier, file);
    if (!workspace) continue;
    const importer = relative(ROOT, file);
    if (target === null) {
      problems.push({ importer, specifier, reason: 'does not resolve to a file in the repo' });
      continue;
    }
    const repoPath = relative(ROOT, target);
    const rule = excludedBy(repoPath);
    if (rule !== null) {
      problems.push({
        importer,
        specifier,
        reason: `resolves to ${repoPath}, which .dockerignore excludes ("${rule}")`,
        chain,
      });
      continue;
    }
    walk(target, [...chain, repoPath]);
  }
}

for (const entry of ENTRYPOINTS) {
  const absolute = join(ROOT, entry);
  if (!existsSync(absolute)) {
    problems.push({ importer: entry, specifier: '—', reason: 'entrypoint does not exist' });
    continue;
  }
  const roots = statSync(absolute).isDirectory() ? sourceFilesUnder(absolute) : [absolute];
  for (const root of roots) walk(root, [entry]);
}

if (problems.length > 0) {
  console.error(
    `\n${problems.length} import(s) reachable from a deployed service cannot be bundled inside its image:\n`,
  );
  for (const problem of problems) {
    console.error(`  ${problem.importer}`);
    console.error(`    imports '${problem.specifier}' — ${problem.reason}`);
    if (problem.chain !== undefined && problem.chain.length > 1) {
      console.error(`    reached from ${problem.chain[0]} via ${problem.chain.length - 1} hop(s)`);
    }
  }
  console.error(
    '\nFix one of these ways:\n' +
      '  - move the code the service needs out of test/ (or another excluded path) into src/\n' +
      '  - stop importing it from production source\n' +
      '  - if it genuinely belongs in the image, re-include the path in .dockerignore and say why\n' +
      'Do not re-include test fixtures: they carry phone numbers (CLAUDE.md invariant 8).\n',
  );
  process.exit(1);
}

console.log(
  `docker context OK — ${seen.size} source files reachable from ${ENTRYPOINTS.length} entrypoints, all present in the build context.`,
);
