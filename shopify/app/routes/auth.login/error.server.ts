import { LoginErrorType, type LoginError } from '@shopify/shopify-app-react-router/server';

export function loginErrorMessage(loginErrors: LoginError): { shop?: string } {
  if (loginErrors.shop === LoginErrorType.MissingShop)
    return { shop: 'Enter your shop domain to log in' };
  if (loginErrors.shop === LoginErrorType.InvalidShop)
    return { shop: 'Enter a valid shop domain, e.g. your-store.myshopify.com' };
  return {};
}
