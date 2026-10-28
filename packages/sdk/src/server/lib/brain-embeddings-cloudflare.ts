import { resolveModelProviderEnvValue } from '@roomote/db/server';

/** Workers AI account ids are 32 hex chars. */
const CLOUDFLARE_WORKERS_AI_ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

export const CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS = 1024;

export type CloudflareWorkersAiEmbeddings = {
  baseUrl: string;
  apiKey: string;
};

export function isCloudflareWorkersAiEmbeddingModel(model: string): boolean {
  return model.startsWith('@cf/');
}

export async function readCloudflareWorkersAiEmbeddings(): Promise<CloudflareWorkersAiEmbeddings | null> {
  const apiKey = (
    await resolveModelProviderEnvValue(['CLOUDFLARE_WORKERS_AI_API_TOKEN'])
  )?.trim();
  const accountId = (
    await resolveModelProviderEnvValue(['CLOUDFLARE_WORKERS_AI_ACCOUNT_ID'])
  )?.trim();

  if (
    !apiKey ||
    !accountId ||
    !CLOUDFLARE_WORKERS_AI_ACCOUNT_ID_RE.test(accountId)
  ) {
    return null;
  }

  return {
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`,
    apiKey,
  };
}
