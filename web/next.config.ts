import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Workspace packages ship TypeScript sources with NodeNext `.js` specifiers; webpack maps them
 * back to `.ts`. Database, Redis and GCS clients stay external (server-only, native deps).
 * ESLint and tsc run as repo-wide gates (`pnpm lint`, `pnpm typecheck`), not inside the build.
 */
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    '@naaradh/compliance',
    '@naaradh/db',
    '@naaradh/notify',
    '@naaradh/pipeline',
    '@naaradh/call-scripts',
    '@naaradh/shared',
  ],
  serverExternalPackages: ['pg', 'ioredis', '@google-cloud/storage', 'pino'],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverActions: { bodySizeLimit: '256kb' },
  },
  webpack(webpackConfig: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    webpackConfig.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return webpackConfig;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Every powerful feature off. microphone stays off until a browser web call ships (Q-36).
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), browsing-topics=()',
          },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          // A page we open cannot reach back into ours through window.opener (tabnabbing, XS-leaks).
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // Our responses are not readable as subresources by other sites …
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
      {
        // … except the storefront snippet, which merchants load on their own domains by design.
        source: '/naaradh.js',
        headers: [{ key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }],
      },
    ];
  },
};

export default config;
