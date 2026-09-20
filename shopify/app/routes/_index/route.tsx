import type { LoaderFunctionArgs } from 'react-router';
import { Form, redirect, useLoaderData } from 'react-router';
import { login } from '../../shopify.server';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get('shop') !== null) throw redirect(`/app?${url.searchParams.toString()}`);
  return { showForm: Boolean(login) };
};

export default function Landing() {
  const { showForm } = useLoaderData<typeof loader>();
  return (
    <main
      style={{
        fontFamily: 'Inter, system-ui, sans-serif',
        maxWidth: 640,
        margin: '48px auto',
        padding: '0 16px',
      }}
    >
      <h1>Naaradh for Shopify</h1>
      <p>
        Your store’s phone line answered by an AI agent, and COD orders confirmed by phone before
        they ship — inside Indian calling rules.
      </p>
      {showForm ? (
        <Form method="post" action="/auth/login">
          <label>
            Shop domain <input type="text" name="shop" placeholder="your-store.myshopify.com" />
          </label>{' '}
          <button type="submit">Log in</button>
        </Form>
      ) : null}
      <p>
        <a href="https://naaradh.com/privacy">Privacy</a> ·{' '}
        <a href="https://naaradh.com/terms">Terms</a> ·{' '}
        <a href="https://naaradh.com/do-not-call">Do not call</a>
      </p>
    </main>
  );
}
