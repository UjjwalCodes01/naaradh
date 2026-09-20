import type { FastifyInstance } from 'fastify';

/**
 * CORS for the website snippet (SPEC §9.2, naaradh.js). Only `POST /v1/intents` is reachable
 * from a browser, and only with a PUBLIC site key: the preflight is answered for any origin (it
 * carries no key, so nothing can be checked yet), and the real response is readable by the page
 * only when auth accepted a public key whose domain list covers that Origin (auth.ts). Secret keys
 * never get CORS headers — they belong on servers. No cookies, so no Allow-Credentials.
 */
export function registerSnippetCors(app: FastifyInstance): void {
  app.options(
    '/v1/intents',
    { config: { public: true, rateLimit: false } },
    async (request, reply) => {
      const origin = request.headers.origin;
      reply.code(204).header('vary', 'Origin');
      if (typeof origin === 'string')
        reply.headers({
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'authorization, content-type, idempotency-key',
          'access-control-max-age': '600',
        });
      return reply.send();
    },
  );

  app.addHook('onSend', async (request, reply, payload) => {
    const origin = request.headers.origin;
    if (request.auth?.kind === 'public' && typeof origin === 'string') {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    return payload;
  });
}
