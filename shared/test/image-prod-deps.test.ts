import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What a production image actually contains, and why a test runner once ended up in three of
 * them.
 *
 * Each service image installs with `pnpm install --prod --filter "@naaradh/<service>..."`. The
 * `...` selects the service *and every workspace package it reaches* — through devDependencies
 * too, because a workspace dependency's test tooling is part of that graph. `--prod` then drops
 * each selected project's devDependencies but installs its `dependencies`.
 *
 * So the rule is: **the `dependencies` of every workspace package a service can reach end up in
 * that service's image**, even when the package itself is only ever used by tests.
 *
 * That is how `vitest` shipped inside hooks, voice and workers: `engines/harness` declared
 * `peerDependencies: { vitest: '*' }`, and `auto-install-peers=true` (.npmrc) turns a peer into
 * a real dependency, which trivy then reported as a fixable CRITICAL in the image. It is a
 * devDependency now. These tests fail if that regresses, in `pnpm test` rather than twenty
 * minutes into an image build.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Build and test tooling: correct in devDependencies, never in an image. */
const DEV_ONLY = [
  'vitest',
  'vite',
  'vite-node',
  'esbuild',
  'rollup',
  'tsup',
  'tsx',
  'typescript',
  'turbo',
  'eslint',
  'prettier',
  'drizzle-kit',
  '@playwright/test',
  'testcontainers',
];

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Every @naaradh/* workspace package, by name. */
function workspacePackages(): Map<string, { dir: string; manifest: Manifest }> {
  const found = new Map<string, { dir: string; manifest: Manifest }>();
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const dirs = [entry.name];
    if (entry.name === 'engines' || entry.name === 'plugins') {
      for (const nested of readdirSync(join(ROOT, entry.name), { withFileTypes: true })) {
        if (nested.isDirectory()) dirs.push(`${entry.name}/${nested.name}`);
      }
    }
    for (const dir of dirs) {
      const file = join(ROOT, dir, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      if (manifest.name?.startsWith('@naaradh/') === true)
        found.set(manifest.name, { dir, manifest });
    }
  }
  return found;
}

const PACKAGES = workspacePackages();

/** The `pnpm --filter "<service>..."` selection: prod *and* dev workspace edges. */
function selection(service: string): string[] {
  const seen = new Set<string>();
  const queue = [service];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = PACKAGES.get(name);
    if (entry === undefined) continue;
    for (const deps of [entry.manifest.dependencies, entry.manifest.devDependencies]) {
      for (const dependency of Object.keys(deps ?? {})) {
        if (dependency.startsWith('@naaradh/')) queue.push(dependency);
      }
    }
  }
  return [...seen];
}

const SERVICES = [
  '@naaradh/api',
  '@naaradh/hooks',
  '@naaradh/voice',
  '@naaradh/workers',
  '@naaradh/console',
];

describe('production images', () => {
  it.each(SERVICES)('%s ships no build or test tooling', (service) => {
    const offenders: string[] = [];
    for (const name of selection(service)) {
      const entry = PACKAGES.get(name);
      if (entry === undefined) continue;
      for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
        if (DEV_ONLY.includes(dependency)) offenders.push(`${name} depends on ${dependency}`);
      }
    }
    expect(offenders, `move these to devDependencies — ${service}'s image installs them`).toEqual(
      [],
    );
  });

  it('declares no peer dependency on build or test tooling', () => {
    // With auto-install-peers=true a peer becomes an ordinary dependency, so a peer on vitest
    // is the same mistake as a dependency on it.
    const offenders: string[] = [];
    for (const [name, entry] of PACKAGES) {
      for (const peer of Object.keys(entry.manifest.peerDependencies ?? {})) {
        if (DEV_ONLY.includes(peer)) offenders.push(`${name} peer-depends on ${peer}`);
      }
    }
    expect(offenders, 'auto-install-peers=true makes these production dependencies').toEqual([]);
  });

  it('keeps the harness runner on the same version as the root runner', () => {
    // A different version would resolve to a second physical copy, and describe/expect would
    // not share the runner's context.
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;
    const harness = PACKAGES.get('@naaradh/engine-harness');
    expect(harness?.manifest.devDependencies?.['vitest']).toBe(root.devDependencies?.['vitest']);
  });
});
