import type { HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { Outlet, useLoaderData, useRouteError } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { AppProvider } from '@shopify/shopify-app-react-router/react';
import { authenticate } from '../shopify.server';
import { env } from '../lib/env.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: env().SHOPIFY_API_KEY };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/setup">Setup</s-link>
        <s-link href="/app/scripts">Call scripts</s-link>
        <s-link href="/app/support">Support line</s-link>
        <s-link href="/app/billing">Plan & billing</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to surface some thrown responses with their headers.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
