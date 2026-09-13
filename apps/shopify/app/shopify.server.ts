import '@shopify/shopify-app-react-router/adapters/node';
import { ApiVersion, AppDistribution, shopifyApp } from '@shopify/shopify-app-react-router/server';
import { env } from './lib/env.server';
import { provisionShop } from './lib/provision.server';
import { NaaradhSessionStorage } from './lib/session-storage.server';

/**
 * ADR-0007: React Router template, offline tokens that expire (refreshed by the library here
 * and by the workers' resolver), sessions encrypted in Postgres. Webhooks are NOT registered by
 * the app: shopify.app.toml points every topic at hooks.naaradh.com (invariant 9, one receiver).
 */
const e = env();

const shopify = shopifyApp({
  apiKey: e.SHOPIFY_API_KEY,
  apiSecretKey: e.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.July26,
  scopes: e.SCOPES.split(','),
  appUrl: e.SHOPIFY_APP_URL,
  authPathPrefix: '/auth',
  sessionStorage: new NaaradhSessionStorage(),
  distribution: AppDistribution.AppStore,
  future: { expiringOfflineAccessTokens: true },
  hooks: {
    afterAuth: async ({ session }) => {
      if (session.accessToken === undefined) return;
      await provisionShop(session.shop, session.accessToken, session.scope);
    },
  },
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const login = shopify.login;
