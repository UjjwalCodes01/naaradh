#!/usr/bin/env node
/**
 * `pnpm env:list <target>` / `pnpm env:check` / `pnpm env:local`
 *
 * One place that answers "which environment variables does this service need, and where does
 * each value come from" — derived from the code, not from a doc that drifts:
 *
 *   - the variables and which are REQUIRED come from each service's own zod schema;
 *   - which are SECRETS, and which service may read each one, come from `secret_holders` in
 *     infra/locals.tf (the key-holder map — the same list that drives the IAM grants);
 *   - which are PLAIN env come from locals.tf's env blocks and the committed tfvars.
 *
 * What it cannot see: the cross-field rules each service applies in `superRefine` (a variable
 * that is optional in the schema but required for `WORKER=analytics`, say). Those are listed by
 * hand under `CONDITIONAL` below so `--check` can still say something useful about them.
 *
 * Terraform's plain-env expressions are conditional HCL (`contains(keys(var.hostnames), …)`),
 * so plain-env coverage is checked by NAME anywhere in the env blocks or the tfvars, not
 * per service. Secret coverage is exact, per service. `--check` therefore catches "nothing
 * sets this anywhere" and "this service may not read that secret" — not "this tfvars file
 * forgot one hostname".
 *
 * Prints names only. No value of any kind is ever read, printed or written by this script,
 * except the freshly generated local development keys `env:local` puts in .env.local.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Every deployed surface, its schema, and where it runs. */
const SERVICES = {
  api: { module: 'api/src/env.ts', schema: 'apiEnvSchema', where: 'Cloud Run (GCP)' },
  hooks: { module: 'hooks/src/env.ts', schema: 'hooksEnvSchema', where: 'Cloud Run (GCP)' },
  voice: { module: 'voice/src/env.ts', schema: 'voiceEnvSchema', where: 'Cloud Run (GCP)' },
  workers: {
    module: 'workers/src/env.ts',
    schema: 'workersEnvSchema',
    where: 'Cloud Run (GCP), one service per WORKER role',
  },
  console: {
    module: 'console/src/env.ts',
    schema: 'consoleEnvSchema',
    where: 'Cloud Run (GCP), behind IAP',
  },
  web: {
    module: 'web/src/lib/env.ts',
    schema: 'webEnvSchema',
    where: 'Cloud Run (GCP) for the dashboard; Vercel serves the marketing pages only',
  },
  shopify: {
    module: 'shopify/app/lib/env.server.ts',
    schema: 'shopifyAppEnvSchema',
    where: 'Cloud Run (GCP)',
  },
};

/**
 * Variables read outside any service's schema, with what reads them. They still have to come
 * from somewhere, so `--check` holds them to the same rule.
 */
const EXTRA_CONSUMERS = {
  DATABASE_MIGRATOR_URL: {
    reader: 'the migrate job (db/src/migrate-cli.ts)',
    principal: 'migrate',
  },
};

/**
 * Set by the platform, not by us: Cloud Run injects PORT, Vercel injects its own VERCEL_*.
 * They are the only variables a schema may require without anything in this repo providing them.
 */
const PLATFORM_PROVIDED = new Set(['PORT', 'HOST']);

/**
 * Variables a schema marks optional but a service refuses to boot without in some
 * configuration (its `superRefine`). Listed here so `env:list` can say so out loud.
 */
/** Injected by a tool rather than set by us, per surface. */
const INJECTED = {
  'shopify.SHOPIFY_API_KEY': '`shopify app dev` injects it locally; Secret Manager in a deployment',
  'shopify.SHOPIFY_API_SECRET':
    '`shopify app dev` injects it locally; Secret Manager in a deployment',
  'shopify.SHOPIFY_APP_URL':
    '`shopify app dev` injects the tunnel locally; the tfvars hostname in a deployment',
};

const CONDITIONAL = {
  'workers.PHONE_ENC_PRIVATE_KEY': 'WORKER=dispatcher | results | reconcile | all',
  'workers.SHOPIFY_TOKEN_KEY':
    'WORKER=writebacks | actions | billing | reconcile | all, in production',
  'workers.SHOPIFY_API_KEY':
    'WORKER=writebacks | actions | billing | reconcile | all, in production',
  'workers.SHOPIFY_API_SECRET':
    'WORKER=writebacks | actions | billing | reconcile | all, in production',
  'workers.BIGQUERY_DATASET': 'WORKER=analytics | all, in production',
  'workers.POSTMARK_TOKEN': 'WORKER=notifications | all, in production',
  'workers.BOLNA_TOOL_TOKEN': 'BOLNA_INBOUND=true',
  'workers.BOLNA_API_KEY': 'an ENGINE_* is bolna',
  'workers.OMNIDIM_API_KEY': 'an ENGINE_* is omnidim',
  'workers.RETELL_API_KEY': 'an ENGINE_* is retell',
  'hooks.BOLNA_API_KEY': 'an ENGINE_* is bolna',
  'hooks.OMNIDIM_API_KEY': 'an ENGINE_* is omnidim',
  'hooks.RETELL_API_KEY': 'an ENGINE_* is retell',
  'voice.BOLNA_API_KEY': 'an ENGINE_* is bolna',
  'voice.OMNIDIM_API_KEY': 'an ENGINE_* is omnidim',
  'voice.RETELL_API_KEY': 'an ENGINE_* is retell',
  'web.POSTMARK_TOKEN': 'production',
  'console.IAP_AUDIENCE': 'production',
  'console.CONSOLE_DEV_STAFF_EMAIL': 'never in production — development only',
};

/** A conditional that only ever applies on a developer's machine needs nothing from infra/. */
const devOnly = (note) => note !== undefined && note.includes('development only');

/** The marketing site on Vercel (docs/go-live/11-marketing-site-vercel.md). */
const VERCEL = [
  {
    name: 'NAARADH_SURFACE',
    value: 'marketing',
    note: 'Serve the marketing pages only. Sign-in, /app, /do-not-call and /api are not served here (no database, no Redis, no keys) — they redirect to DASHBOARD_URL.',
  },
  {
    name: 'DASHBOARD_URL',
    value: 'https://app.naaradh.com',
    note: "Where those paths redirect to: the dashboard's own deployment (Cloud Run). Until that service is enabled, they answer 404.",
  },
];

// ---------------------------------------------------------------------------
// The schemas
// ---------------------------------------------------------------------------

/** Unwraps a zod field far enough to tell "must be set" from "may be left out". */
function required(field) {
  let f = field;
  for (let i = 0; i < 12; i += 1) {
    const t = f?._def?.typeName;
    if (t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodNullable') return false;
    if (t === 'ZodEffects') f = f._def.schema;
    else if (t === 'ZodPipeline') f = f._def.in;
    else return true;
  }
  return true;
}

function shapeOf(schema) {
  let s = schema;
  for (let i = 0; i < 12; i += 1) {
    if (typeof s?._def?.shape === 'function') return s._def.shape();
    if (s?._def?.schema !== undefined) s = s._def.schema;
    else if (s?._def?.in !== undefined) s = s._def.in;
    else break;
  }
  throw new Error('not a zod object schema');
}

async function loadServices() {
  const out = {};
  for (const [name, meta] of Object.entries(SERVICES)) {
    const mod = await import(new URL(`../${meta.module}`, import.meta.url).href);
    const schema = mod[meta.schema];
    if (schema === undefined) throw new Error(`${meta.module} does not export ${meta.schema}`);
    const shape = shapeOf(schema);
    out[name] = {
      ...meta,
      vars: Object.entries(shape)
        .map(([key, field]) => ({ name: key, required: required(field) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the infrastructure provides
// ---------------------------------------------------------------------------

/** Text of one `name = { … }` HCL block, brace-matched. */
function hclBlock(text, name) {
  const start = text.indexOf(`${name} = {`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

const ENV_NAME = /\b([A-Z][A-Z0-9_]{2,})\b/g;

function infraCoverage() {
  const locals = read('infra/locals.tf');
  // Exact, per service: the key-holder map that also drives the IAM grants.
  const holders = new Map();
  for (const line of hclBlock(locals, 'secret_holders').split('\n')) {
    const m = /^\s{4}([A-Z][A-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (m === null) continue;
    const principals = [...m[2].matchAll(/"([a-z][a-z0-9-]*)"/g)].map((x) => x[1]);
    const groups = [];
    if (/local\.workers/.test(m[2])) groups.push('workers');
    if (/local\.shopify_admin_workers/.test(m[2])) groups.push('workers');
    holders.set(m[1], new Set([...principals, ...groups]));
  }
  const optional = new Set(
    [...hclBlock(locals, 'optional_secrets = [').matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((x) => x[1]),
  );
  // Coarse, by name: Terraform's plain env is conditional HCL, and the tfvars add their own.
  const plain = new Set();
  const plainSources = [
    hclBlock(locals, 'base_env'),
    locals.slice(locals.indexOf('url_env = merge('), locals.indexOf('# Guard rails')),
  ];
  for (const file of ['dev', 'stage', 'prod-in', 'prod-us', 'prod-eu'])
    plainSources.push(read(`infra/envs/${file}.tfvars`));
  for (const text of plainSources) for (const m of text.matchAll(ENV_NAME)) plain.add(m[1]);
  return { holders, optional, plain };
}

function optionalSecretsList() {
  const locals = read('infra/locals.tf');
  const block = locals.slice(
    locals.indexOf('optional_secrets = ['),
    locals.indexOf(']', locals.indexOf('optional_secrets = [')),
  );
  return new Set([...block.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]));
}

/** Where a service gets one variable's value. */
function sourceOf(name, service, infra) {
  if (PLATFORM_PROVIDED.has(name)) return { kind: 'platform', detail: 'set by Cloud Run' };
  const holders = infra.holders.get(name);
  if (holders !== undefined)
    // Terraform grants per worker ROLE (`workers-dispatcher`); the schema is shared by them all,
    // and which role needs what is in CONDITIONAL.
    return [...holders].some(
      (h) => h === service || (service === 'workers' && h.startsWith('workers')),
    )
      ? {
          kind: 'secret',
          detail: infra.optional.has(name)
            ? 'Secret Manager (optional: list it in enabled_optional_secrets)'
            : 'Secret Manager',
        }
      : {
          kind: 'secret-denied',
          detail: `Secret Manager, but only for: ${[...holders].sort().join(', ')}`,
        };
  if (infra.plain.has(name)) return { kind: 'plain', detail: 'plain env (locals.tf / tfvars)' };
  return { kind: 'missing', detail: 'nothing in infra/ sets it' };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printService(name, service, infra) {
  const out = [`${name} — ${service.where}`, ''];
  const line = (v) => {
    const src = sourceOf(v.name, name, infra);
    const conditional = CONDITIONAL[`${name}.${v.name}`];
    const injected = INJECTED[`${name}.${v.name}`];
    const tail =
      injected !== undefined
        ? `  — ${injected}`
        : conditional === undefined
          ? ''
          : `  — needed when: ${conditional}`;
    // An optional variable nothing sets simply keeps the default in its schema.
    const detail =
      src.kind === 'missing' && !v.required
        ? "the schema's default; override in tfvars"
        : src.detail;
    return `  ${v.name.padEnd(28)} ${detail}${tail}`;
  };
  const req = service.vars.filter((v) => v.required);
  const opt = service.vars.filter((v) => !v.required);
  out.push('required (the service refuses to boot without it)');
  out.push(...req.map(line), '');
  out.push('optional (a default, or a feature that stays off)');
  out.push(...opt.map(line), '');
  out.push(
    'Terraform creates every secret as an EMPTY container and grants this service the ones above;',
    'a human adds each value once, per environment:',
    '',
    '  gcloud secrets versions add <NAME> --project naaradh-<env> --data-file=-',
    '',
    'Plain env is set in infra/envs/<env>.tfvars — `common_env` for every service, or',
    `\`service_env.${name}\` for this one. An OPTIONAL secret is mounted only once it is also`,
    "listed in that file's `enabled_optional_secrets` (Cloud Run refuses a version-less secret).",
    '',
  );
  return out.join('\n');
}

function printVercel() {
  return [
    'vercel — the marketing site (web, NAARADH_SURFACE=marketing)',
    '',
    'Project → Settings → Environment Variables, for Production and Preview:',
    '',
    ...VERCEL.flatMap((v) => [`  ${v.name}=${v.value}`, `    ${v.note}`, '']),
    'Nothing else. The marketing pages read no database, no Redis and no key, which is why',
    'this deployment can hold no credential at all. The template lives in web/.env.example.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

/** KEY= lines of a committed template (values are never read). */
function templateKeys(path) {
  const keys = new Set();
  for (const line of read(path).split('\n')) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
    if (m !== null) keys.add(m[1]);
  }
  return keys;
}

function check(services, infra) {
  const problems = [];
  const all = new Set();
  for (const [name, service] of Object.entries(services)) {
    for (const v of service.vars) {
      all.add(v.name);
      const src = sourceOf(v.name, name, infra);
      const note = CONDITIONAL[`${name}.${v.name}`];
      const conditional = note !== undefined && !devOnly(note);
      if (src.kind === 'missing' && (v.required || conditional))
        problems.push(
          `${name}: ${v.name} is ${v.required ? 'required' : 'needed in some configuration'} but nothing in infra/ provides it`,
        );
      if (src.kind === 'secret-denied' && (v.required || conditional))
        problems.push(`${name}: ${v.name} — ${src.detail} (infra/locals.tf secret_holders)`);
    }
  }
  // Read outside the schemas, but still has to come from somewhere.
  for (const [name, consumer] of Object.entries(EXTRA_CONSUMERS)) {
    all.add(name);
    const src = sourceOf(name, consumer.principal, infra);
    if (src.kind !== 'secret' && src.kind !== 'plain')
      problems.push(`${name} is read by ${consumer.reader}, but ${src.detail}`);
  }
  // Local development: .env.example is the one file a developer copies.
  const local = templateKeys('.env.example');
  for (const name of [...all].sort())
    if (!local.has(name) && !PLATFORM_PROVIDED.has(name))
      problems.push(`.env.example does not mention ${name} (a service's schema accepts it)`);
  for (const name of [...local].sort())
    if (!all.has(name) && !PLATFORM_PROVIDED.has(name))
      problems.push(`.env.example sets ${name}, which no service's schema accepts`);
  // The Vercel template and this script must agree.
  const vercel = templateKeys('web/.env.example');
  for (const v of VERCEL)
    if (!vercel.has(v.name)) problems.push(`web/.env.example does not mention ${v.name}`);
  // A committed template must never carry a real credential. The docker-compose URLs and the
  // simulator's public development secret are not credentials: they work only on localhost and
  // production refuses them.
  const secretNames = new Set([...infra.holders.keys(), ...optionalSecretsList()]);
  const devSafe = (value) =>
    value === '' ||
    value === '{}' ||
    value === '[]' ||
    /^(true|false|off|on|\d+)$/.test(value) ||
    value.includes('local_dev_only') ||
    /(localhost|127\.0\.0\.1)/.test(value);
  for (const path of ['.env.example', 'web/.env.example'])
    for (const line of read(path).split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
      if (m !== null && secretNames.has(m[1]) && !devSafe(m[2].trim()))
        problems.push(`${path}: ${m[1]} has a value — a committed file never holds a credential`);
    }
  return problems;
}

// ---------------------------------------------------------------------------
// env:local — a .env.local a developer can actually run `pnpm dev` with
// ---------------------------------------------------------------------------

function writeLocal() {
  const target = join(ROOT, '.env.local');
  if (existsSync(target)) {
    process.stderr.write('.env.local already exists — delete it first, or edit it by hand.\n');
    process.exit(1);
  }
  // The same generator the runbooks use, so local keys are never hand-rolled.
  const keys = execFileSync(process.execPath, [join(ROOT, 'scripts/gen-dev-keys.mjs')], {
    encoding: 'utf8',
  });
  const generated = new Map();
  for (const line of keys.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
    if (m !== null) generated.set(m[1], m[2]);
  }
  const out = [];
  for (const line of read('.env.example').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
    const value = m === null ? undefined : generated.get(m[1]);
    out.push(value === undefined ? line : `${m[1]}=${value}`);
  }
  out.unshift(
    '# Local development only — generated by `pnpm env:local`, git-ignored, never deployed.',
    `# Keys below are fresh and belong to this machine alone (scripts/gen-dev-keys.mjs).`,
    '',
  );
  writeFileSync(target, out.join('\n'));
  process.stdout.write(
    `wrote .env.local (${String(generated.size)} development keys generated).\n` +
      'Then: `pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev`.\n',
  );
}

// ---------------------------------------------------------------------------

const arg = process.argv[2] ?? '--help';
const infra = { ...infraCoverage(), optional: optionalSecretsList() };

if (arg === 'local') {
  writeLocal();
} else if (arg === '--check') {
  const services = await loadServices();
  const problems = check(services, infra);
  if (problems.length === 0) {
    process.stdout.write(
      'env:check — every service can boot from infra/, and the templates match.\n',
    );
  } else {
    process.stderr.write(`env:check — ${String(problems.length)} problem(s):\n\n`);
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    process.stderr.write(
      '\nFix the schema, infra/locals.tf (secret_holders / optional_secrets), the tfvars, or the template.\n',
    );
    process.exit(1);
  }
} else if (arg === 'vercel') {
  process.stdout.write(printVercel());
} else if (arg === 'all') {
  const services = await loadServices();
  process.stdout.write(
    [...Object.entries(services).map(([n, s]) => printService(n, s, infra)), printVercel()].join(
      '\n',
    ),
  );
} else if (Object.hasOwn(SERVICES, arg)) {
  const services = await loadServices();
  process.stdout.write(printService(arg, services[arg], infra));
} else {
  process.stdout.write(
    [
      'usage: pnpm env:list <service|vercel|all>   which variables a surface needs, and where each value comes from',
      '       pnpm env:check                      every service can boot from infra/, and the templates match the schemas',
      '       pnpm env:local                      write a .env.local for this machine (fresh development keys)',
      '',
      `services: ${Object.keys(SERVICES).join(', ')}`,
      '',
    ].join('\n'),
  );
}
