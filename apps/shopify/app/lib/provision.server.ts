import { withTenant } from '@naaradh/db';
import { dataRegionFor, ensureDefaultSetup, provisionShopifyInstall } from '@naaradh/pipeline';
import { billingCurrency, createAdminClient } from '@naaradh/shopify-sdk';
import { systemClock } from '@naaradh/shared';
import { db } from './db.server';
import { env } from './env.server';

/**
 * afterAuth (install, reinstall, token re-issue): read the shop, then create or revive its tenant
 * through provision_shopify_install() and add the default use cases and draft scripts. Idempotent.
 */
const SHOP_QUERY = /* GraphQL */ `
  query NaaradhShop {
    shop {
      name
      email
      currencyCode
      ianaTimezone
      primaryDomain {
        host
      }
      billingAddress {
        countryCodeV2
      }
    }
  }
`;

interface ShopFields {
  shop: {
    name: string;
    email: string | null;
    currencyCode: string;
    ianaTimezone: string;
    billingAddress: { countryCodeV2: string | null } | null;
  };
}

export async function provisionShop(
  shop: string,
  accessToken: string,
  scope: string | undefined,
): Promise<string> {
  const client = createAdminClient({
    shop,
    accessToken,
    apiVersion: env().SHOPIFY_ADMIN_API_VERSION,
  });
  const data = await client.request<ShopFields>(SHOP_QUERY);
  const country = (data.shop.billingAddress?.countryCodeV2 ?? 'IN').toUpperCase();
  const billing = await billingCurrency(client).catch(() => data.shop.currencyCode);
  const r = await provisionShopifyInstall(db(), {
    shop,
    name: data.shop.name,
    country,
    dataRegion: dataRegionFor(country),
    timezone: data.shop.ianaTimezone || 'Asia/Kolkata',
    currency: billing === 'INR' ? 'INR' : 'USD',
    ownerEmail: data.shop.email,
    scopes: (scope ?? env().SCOPES)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    apiVersion: env().SHOPIFY_ADMIN_API_VERSION,
    now: systemClock.now(),
  });
  await withTenant(db(), r.tenantId, (tx) =>
    ensureDefaultSetup(
      tx,
      { tenantId: r.tenantId, type: 'user', id: `shopify:${shop}` },
      country === 'IN' ? 'hi-IN' : 'en-IN',
    ),
  );
  return r.tenantId;
}
