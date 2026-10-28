import { Env } from '@roomote/env';

import {
  isCloudflareWorkersAiEmbeddingModel,
  readCloudflareWorkersAiEmbeddings,
} from './brain-embeddings-cloudflare';
import { resolveBrainInferenceProvider } from './brain-inference-provider';

export type BrainEmbeddingsUpstream = {
  baseUrl: string;
  apiKey?: string;
  source: 'configured' | 'cloudflare-workers-ai';
};

export async function readBrainEmbeddingsUpstream(
  requestedModel?: string,
): Promise<BrainEmbeddingsUpstream | null> {
  const configured = Env.R_BRAIN_EMBEDDINGS_UPSTREAM_URL?.trim();

  if (configured) {
    return {
      baseUrl: configured.replace(/\/$/, ''),
      apiKey: Env.R_BRAIN_INFERENCE_UPSTREAM_API_KEY?.trim() || undefined,
      source: 'configured',
    };
  }

  const cloudflare = await readCloudflareWorkersAiEmbeddings();

  if (!cloudflare) {
    return null;
  }

  const useCloudflare = requestedModel
    ? isCloudflareWorkersAiEmbeddingModel(requestedModel)
    : !(await resolveBrainInferenceProvider());

  if (!useCloudflare) {
    return null;
  }

  return { ...cloudflare, source: 'cloudflare-workers-ai' };
}
