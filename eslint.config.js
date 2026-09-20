import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import naaradh from './tools/eslint-plugin-naaradh/index.js';

/**
 * Every workspace folder at the repo root (kept in step with pnpm-workspace.yaml). The rules
 * below are keyed on these paths and ENFORCE invariants — the vendor-SDK ban (13), the
 * RLS-bypassing service role (15), luxon-only window maths — so a folder missing from this
 * list would silently lose its guard rails. `pnpm env:check` and the tests do not catch that;
 * only this list does.
 */
const WORKSPACES = [
  'api',
  'hooks',
  'voice',
  'workers',
  'web',
  'shopify',
  'console',
  'compliance',
  'db',
  'engines',
  'call-scripts',
  'pipeline',
  'shared',
  'shopify-sdk',
  'calendar',
  'notify',
  'payments',
];
const ALL_WORKSPACE_CODE = WORKSPACES.flatMap((w) => [`${w}/**/*.ts`, `${w}/**/*.tsx`]);

/**
 * Type-aware linting is on: several of the rules that matter most here (no-floating-promises
 * in the workers, only-throw-error for NaaradhError, no-misused-promises in Fastify handlers)
 * cannot work without type information.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.shopify/**',
      '**/.next/**',
      '**/.react-router/**',
      'shopify/build/**',
      'web/next-env.d.ts',
      'plugins/woocommerce/**', // PHP
    ],
  },

  // Plain JS (the local ESLint plugin, scripts): no type-aware rules.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },

  // k6 load scripts (load/): ES modules run by k6, not Node — its globals, no type info.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['load/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly' },
    },
  },

  // The website snippet runs in merchants' pages: browser globals, ES2017, no modules.
  {
    files: ['web/public/naaradh.js'],
    languageOptions: {
      ecmaVersion: 2017,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        HTMLFormElement: 'readonly',
        CustomEvent: 'readonly',
      },
    },
  },

  {
    files: ['**/*.ts', 'web/**/*.tsx', 'shopify/app/**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { naaradh },
    rules: {
      'naaradh/no-raw-phone-literal': 'error',
      'naaradh/no-pii-in-logs': 'error',

      // CLAUDE.md coding conventions.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/only-throw-error': 'error', // never throw strings
      '@typescript-eslint/no-floating-promises': 'error',
      // Port implementations and fakes legitimately return a Promise without awaiting.
      '@typescript-eslint/require-await': 'off',
      // Underscore marks a deliberately unused parameter (interface conformance).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error', // outcome/gate enums
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],

      // Invariant 13: no vendor SDK outside engines/<vendor>/.
      // Product code only ever sees VoiceEngineAdapter.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'retell-sdk',
                '@retell/*',
                'bolna*',
                'omnidim*',
                'twilio',
                'plivo',
                'exotel*',
                '@naaradh/engine-bolna',
                '@naaradh/engine-omnidim',
                '@naaradh/engine-retell',
              ],
              message:
                'Vendor SDKs and vendor adapter packages may only be imported inside engines/<vendor>/ (invariant 13). Product code depends on @naaradh/engines-core and resolves an adapter through the registry.',
            },
          ],
        },
      ],
    },
  },

  // The engines workspace is where vendor code is allowed to exist.
  {
    files: ['engines/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Invariant 15: the BYPASSRLS service role is importable only where cross-tenant access
  // is the job — hooks (webhook_events before a tenant is known), the cross-tenant workers,
  // the staff console (IAP-only),
  // the api's bootstrap module (tenant creation), and tests. Nothing that serves a merchant
  // request may touch it.
  {
    files: ALL_WORKSPACE_CODE,
    ignores: [
      'hooks/**',
      'workers/**',
      // The staff console (behind IAP) acts across tenants by design — never a merchant surface.
      'console/**',
      'api/src/bootstrap/**',
      'db/**',
      '**/test/**',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@naaradh/db/service',
              message:
                'createServiceDb() bypasses RLS (invariant 15). Only hooks, cross-tenant workers and api/src/bootstrap may import it; everything else goes through withTenant().',
            },
          ],
          patterns: [
            {
              group: [
                'retell-sdk',
                '@retell/*',
                'bolna*',
                'omnidim*',
                'twilio',
                'plivo',
                'exotel*',
                '@naaradh/engine-bolna',
                '@naaradh/engine-omnidim',
                '@naaradh/engine-retell',
              ],
              message:
                'Vendor SDKs and vendor adapter packages may only be imported inside engines/<vendor>/ (invariant 13).',
            },
          ],
        },
      ],
    },
  },

  // The engines workspace resolves vendor adapters (the registry imports them), so the vendor
  // ban above does not apply there; the service-role ban still does.
  {
    files: ['engines/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@naaradh/db/service',
              message:
                'createServiceDb() bypasses RLS (invariant 15). Voice engine adapters never touch the database.',
            },
          ],
        },
      ],
    },
  },

  // Window and deadline arithmetic must go through luxon in the recipient's IANA zone.
  // `new Date()` maths is how 09:00-21:00 IST and the 30-minute rule get silently broken.
  // Scoped to the DECISION code: adapters (cache TTLs, Redis keys) and tests may use the clock.
  {
    files: [
      'compliance/src/gate/**/*.ts',
      'compliance/src/consent.ts',
      'compliance/src/retry.ts',
      'compliance/src/billable.ts',
      'compliance/src/constants.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'Do not construct Date here. Compute windows and deadlines with luxon in the recipient IANA zone (CLAUDE.md: never use Date arithmetic for windows).',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Do not read the clock directly in compliance code. Take the current instant as an argument so boundary tests (08:59/09:00/20:59/21:00 IST, +29m59s/+30m01s) can control it.',
        },
      ],
    },
  },

  // React Router (the Shopify app) signals redirects and HTTP errors by throwing a Response.
  {
    files: ['shopify/app/**/*.ts', 'shopify/app/**/*.tsx'],
    rules: {
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'lib', name: 'Response' }] },
      ],
    },
  },

  // Tests may reach for fixtures and non-null assertions.
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  prettier,
);
