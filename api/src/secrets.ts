/**
 * Writing side of secrets (merchant webhook signing secrets). Production stores them in
 * Secret Manager and keeps only the resource name in Postgres; local/test keeps them inline
 * behind an explicit `inline:` prefix that the production resolver refuses.
 */
export interface SecretStore {
  put(name: string, value: string): Promise<string>;
}

export function inlineSecretStore(): SecretStore {
  return { put: async (_name, value) => `inline:${value}` };
}

/**
 * Secrets are created with USER-MANAGED replication in the service's own region: the org policy
 * restricts resource locations to asia-south1/2, and automatic replication would be refused.
 */
export function secretManagerStore(projectId: string, region: string): SecretStore {
  return {
    async put(name, value) {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const parent = `projects/${projectId}`;
      const secretId = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      try {
        await client.createSecret({
          parent,
          secretId,
          secret: { replication: { userManaged: { replicas: [{ location: region }] } } },
        });
      } catch (error) {
        if (!(error instanceof Error && /ALREADY_EXISTS/.test(error.message))) throw error;
      }
      const [version] = await client.addSecretVersion({
        parent: `${parent}/secrets/${secretId}`,
        payload: { data: Buffer.from(value, 'utf8') },
      });
      return `sm://${version.name ?? `${parent}/secrets/${secretId}/versions/latest`}`;
    },
  };
}
