import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@naaradh/db';
import { audit } from '@naaradh/pipeline';
import { NaaradhError } from '@naaradh/shared';
import { requireScope } from '../auth.js';

/**
 * GET /v1/calls/:id/recording → a signed URL valid for 15 minutes (SPEC §9.1). Every access
 * is audited (E-74); the vendor's URL is never what is returned (E-34).
 */
export interface Signer {
  signedUrl(uri: string, ttlSec: number): Promise<string>;
}

export function gcsSigner(): Signer {
  return {
    async signedUrl(uri, ttlSec) {
      const { Storage } = await import('@google-cloud/storage');
      const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
      if (m === null || m[1] === undefined || m[2] === undefined)
        throw new NaaradhError('NOT_FOUND', 'recording not available');
      const [url] = await new Storage()
        .bucket(m[1])
        .file(m[2])
        .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlSec * 1000 });
      return url;
    },
  };
}

/** Dev/test: a URL that points at nothing but is shaped like the real thing. */
export function devSigner(): Signer {
  return { signedUrl: async (uri, ttlSec) => `${uri}?signed=dev&expires_in=${String(ttlSec)}` };
}

export function registerCallRoutes(
  app: FastifyInstance,
  deps: { db: Db; signer: Signer; clock: () => Date },
): void {
  app.get<{ Params: { id: string } }>('/v1/calls/:id/recording', async (request) => {
    const auth = requireScope(request, 'calls:read');
    const uri = await withTenant(deps.db, auth.tenantId, async (tx) => {
      const [row] = await tx
        .select({ id: schema.callAttempts.id, uri: schema.callAttempts.recordingUri })
        .from(schema.callAttempts)
        .where(
          and(
            eq(schema.callAttempts.tenantId, auth.tenantId),
            eq(schema.callAttempts.id, request.params.id),
          ),
        )
        .limit(1);
      if (row === undefined) throw new NaaradhError('NOT_FOUND', 'call not found');
      if (row.uri === null) throw new NaaradhError('NOT_FOUND', 'no recording for this call');
      await audit(tx, {
        tenantId: auth.tenantId,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'recording.accessed',
        targetType: 'call_attempt',
        targetId: row.id,
        requestId: request.id,
      });
      return row.uri;
    });
    const ttl = 15 * 60;
    return {
      url: await deps.signer.signedUrl(uri, ttl),
      expires_at: new Date(deps.clock().getTime() + ttl * 1000).toISOString(),
    };
  });
}
