/**
 * Which provider the Brain's own inference runs through, and under which
 * model names. Split by responsibility in the sibling modules; this file
 * is the public surface `export * from './lib/brain-inference'` re-exports.
 */

export {
  type BrainInferenceProviderId,
  type ResolvedBrainInference,
  resetBrainInferenceProviderCache,
  resolveBrainInferenceProvider,
} from './brain-inference-provider';

export {
  CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS,
  CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL,
  type BrainEmbeddingsUpstream,
  isBrainEmbeddingAvailable,
  resetBrainEmbeddingsUpstreamCache,
  resolveBrainEmbeddingsUpstream,
} from './brain-embeddings-upstream';

export { mapBrainModelName } from './brain-inference-models';

export {
  type BrainModelSummary,
  describeBrainModels,
} from './brain-inference-model-summary';

export { getBrainGatewayToken } from './brain-gateway-token';
