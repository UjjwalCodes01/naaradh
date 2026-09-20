import { createServer, type Server } from 'node:http';
import type { Redis } from 'ioredis';
import { pingDb, type Db } from '@naaradh/db';

/**
 * Cloud Run runs the workers as services, which must listen on $PORT. There is no API here:
 * `/healthz` says the process is up, `/readyz` that Postgres and Redis answer. Everything else
 * is 404. Bound only when PORT is set, so local `WORKER=all pnpm dev` needs no free port.
 */
export function startHealthServer(deps: {
  readonly port: number;
  readonly db: Db;
  readonly redis: Redis;
}): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' || (path !== '/healthz' && path !== '/readyz')) {
      res.writeHead(404).end();
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    void (async () => {
      const [db, redis] = await Promise.all([
        pingDb(deps.db),
        deps.redis
          .ping()
          .then(() => true)
          .catch(() => false),
      ]);
      const ok = db && redis;
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok, db, redis }));
    })();
  });
  server.listen(deps.port, '0.0.0.0');
  return server;
}
