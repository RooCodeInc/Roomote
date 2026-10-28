import { Env } from '@roomote/env';

import { MODEL_TRANSLATIONS } from './brain-inference-model-names';
import type { BrainInferenceProviderId } from './brain-inference-provider';

export type BrainModelSummary = {
  /** In the serving provider's own naming, as the gateway will forward it. */
  synthesisModel: string;
  synthesisSource: 'default' | 'override';
  embeddingModel: string;
  /** Known for the stock embedding models; null for an operator's own. */
  embeddingDimensions: number | null;
};

function knownEmbeddingDimensions(model: string): number | null {
  if (model.includes('text-embedding-3-large')) {
    return 3072;
  }

  if (model.includes('text-embedding-3-small')) {
    return 1536;
  }

  // Cloudflare Workers AI `@cf/baai/bge-m3` and Infinity `BAAI/bge-m3`.
  if (model.includes('bge-m3')) {
    return 1024;
  }

  return null;
}

/**
 * Models the Brain is effectively running, for display. Synthesis follows
 * `R_BRAIN_MODEL` or the translation table; embeddings follow
 * `R_BRAIN_EMBEDDING_MODEL` (create-time).
 */
export function describeBrainModels(
  providerId: BrainInferenceProviderId,
): BrainModelSummary {
  const override = Env.R_BRAIN_MODEL?.trim();
  const chat = MODEL_TRANSLATIONS.find((entry) => entry.kind === 'chat')!;
  const stockEmbedding = MODEL_TRANSLATIONS.find(
    (entry) => entry.kind === 'embedding',
  )!;
  const embeddingModel =
    Env.R_BRAIN_EMBEDDING_MODEL?.trim() ||
    (providerId === 'openrouter'
      ? stockEmbedding.openrouter
      : stockEmbedding.openai);

  return {
    synthesisModel:
      override || (providerId === 'openrouter' ? chat.openrouter : chat.openai),
    synthesisSource: override ? 'override' : 'default',
    embeddingModel,
    embeddingDimensions:
      Env.R_BRAIN_EMBEDDING_DIMENSIONS ??
      knownEmbeddingDimensions(embeddingModel),
  };
}
