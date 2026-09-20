import { PassThrough } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';
import { ServerRouter, type EntryContext } from 'react-router';
import { createReadableStreamFromReadable } from '@react-router/node';
import { isbot } from 'isbot';
import { addDocumentResponseHeaders } from './shopify.server';

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  // Shopify's frame-ancestors CSP for the embedded app, per shop.
  addDocumentResponseHeaders(request, responseHeaders);
  const callbackName = isbot(request.headers.get('user-agent') ?? '')
    ? 'onAllReady'
    : 'onShellReady';
  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          responseHeaders.set('Content-Type', 'text/html');
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error instanceof Error ? error : new Error('render failed'));
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );
    setTimeout(abort, streamTimeout + 1000);
  });
}
