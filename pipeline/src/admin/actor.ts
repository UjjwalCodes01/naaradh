import type { ActorType } from '../audit.js';

/**
 * Who is changing a tenant's configuration — an API key (api) or a signed-in dashboard
 * user (web, shopify). The admin operations take one so both surfaces write the same
 * audit rows and enforce the same rules; only authentication differs.
 */
export interface Actor {
  readonly tenantId: string;
  readonly type: Extract<ActorType, 'api_key' | 'user'>;
  readonly id: string;
  readonly requestId?: string;
}

/** `api_key:key_…` / `user:usr_…` — for columns that record who did something as text. */
export function actorLabel(actor: Actor): string {
  return `${actor.type}:${actor.id}`;
}

export function auditActor(actor: Actor): {
  readonly tenantId: string;
  readonly actorType: Actor['type'];
  readonly actorId: string;
  readonly requestId?: string;
} {
  return {
    tenantId: actor.tenantId,
    actorType: actor.type,
    actorId: actor.id,
    ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
  };
}
