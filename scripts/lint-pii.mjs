#!/usr/bin/env node
/**
 * `pnpm lint:pii` — repo-wide scan for raw phone numbers in committed text.
 *
 * CLAUDE.md invariant 8: raw phone numbers never appear in logs, error messages, analytics
 * exports, or test fixtures committed to git. ESLint covers TS/JS; this covers everything
 * else a real number tends to leak into — JSON fixtures, SQL seeds, CSV exports, Markdown
 * runbooks, Terraform vars.
 *
 * Findings are printed MASKED. A linter that echoes the number it found into a CI log has
 * just published it.
 *
 * Escape hatch: put `naaradh-pii-allow` in a comment on the same line, with a reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();

/** Must stay in sync with tools/eslint-plugin-naaradh and shared/test/fake-phones.ts. */
const FAKE_PREFIXES = [
  '+916000000',
  '+121255501',
  '+180855501',
  '+190755501',
  '+190255501',
  '+447700900',
];

const PATTERNS = [
  { name: 'e164', re: /\+\d{10,15}/g },
  { name: 'india-mobile', re: /(?<![\d.])[6-9]\d{9}(?![\d.])/g },
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.shopify',
  '.terraform',
  'pnpm-lock.yaml',
]);

const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.sql',
  '.yaml',
  '.yml',
  '.csv',
  '.txt',
  '.html',
  '.php',
  '.tf',
  '.tfvars',
  '.sh',
  '.example',
]);

/** Files that legitimately contain the fake ranges and the detection patterns themselves. */
const SELF_REFERENTIAL = new Set([
  join('scripts', 'lint-pii.mjs'),
  join('tools', 'eslint-plugin-naaradh', 'index.js'),
]);

function isFake(match) {
  const normalised = match.startsWith('+') ? match : `+91${match}`;
  return FAKE_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/** +919812345678 -> +91*******678 */
function mask(match) {
  if (match.length <= 6) return '*'.repeat(match.length);
  return `${match.slice(0, 3)}${'*'.repeat(match.length - 6)}${match.slice(-3)}`;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (SCAN_EXTENSIONS.has(extname(entry)) || entry === '.env.example') {
      yield full;
    }
  }
}

const findings = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (SELF_REFERENTIAL.has(rel)) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable; nothing to scan
  }

  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (line.includes('naaradh-pii-allow')) return;

    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        if (isFake(match[0])) continue;
        findings.push({
          file: rel,
          line: index + 1,
          column: match.index + 1,
          pattern: name,
          masked: mask(match[0]),
        });
      }
    }
  });
}

if (findings.length === 0) {
  console.log('lint:pii — clean. No raw phone numbers found in committed text.');
  process.exit(0);
}

console.error(`lint:pii — ${String(findings.length)} possible raw phone number(s) found.\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${String(f.line)}:${String(f.column)}  ${f.masked}  [${f.pattern}]`);
}
console.error(
  [
    '',
    'Invariant 8: raw phone numbers must not be committed.',
    '',
    'Fix by one of:',
    '  - use a reserved fake range from shared/test/fake-phones.ts',
    '  - store phone_hash (HMAC) instead of the number, if this is a lookup',
    '  - if this is genuinely not a phone number, add `naaradh-pii-allow` with a reason on that line',
    '',
    `Fake ranges: ${FAKE_PREFIXES.join(', ')}`,
  ].join('\n'),
);
process.exit(1);
