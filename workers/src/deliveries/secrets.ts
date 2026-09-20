/**
 * Resolves a `secret_ref` to its value — merchant webhook signing secrets and store Admin API
 * tokens (`integrations.credentials_secret_ref`). Production: Secret Manager
 * (`sm://projects/…`), cached 5 minutes. Local/test: `inline:<value>`, refused in production.
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export function inlineSecretResolver(): SecretResolver {
  return {
    async resolve(ref) {
      if (ref.startsWith('inline:')) return ref.slice('inline:'.length);
      throw new Error(`cannot resolve secret ref ${ref.slice(0, 12)}… without Secret Manager`);
    },
  };
}

export function secretManagerResolver(): SecretResolver {
  const cache = new Map<string, { value: string; expires: number }>();
  return {
    async resolve(ref) {
      if (ref.startsWith('inline:'))
        throw new Error('inline secrets are not allowed in production');
      const hit = cache.get(ref);
      if (hit !== undefined && hit.expires > Date.now()) return hit.value;
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const name = ref.startsWith('sm://') ? ref.slice(5) : ref;
      const [version] = await client.accessSecretVersion({
        name: name.endsWith('/versions/latest') ? name : `${name}/versions/latest`,
      });
      const value = version.payload?.data?.toString() ?? '';
      if (value.length === 0) throw new Error('empty secret');
      cache.set(ref, { value, expires: Date.now() + 5 * 60_000 });
      return value;
    },
  };
}
