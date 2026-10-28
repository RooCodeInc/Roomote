import {
  type BrainEmbeddingsUpstream,
  readBrainEmbeddingsUpstream,
} from './brain-embeddings-upstream-read';
import { resolveBrainInferenceProvider } from './brain-inference-provider';

export {
  CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS,
  CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL,
} from './brain-embeddings-cloudflare';
export type { BrainEmbeddingsUpstream } from './brain-embeddings-upstream-read';

const UPSTREAM_CACHE_TTL_MS = 30_000;

let upstreamCache: {
  values: Map<string, BrainEmbeddingsUpstream | null>;
  expiresAtMs: number;
} | null = null;

/** Drop the cached upstream so the next call re-reads settings. */
export function resetBrainEmbeddingsUpstreamCache(): void {
  upstreamCache = null;
}

/**
 * Where Memory embeddings are forwarded. `R_BRAIN_EMBEDDINGS_UPSTREAM_URL`
 * always wins. A `@cf/` request stays on Workers AI even after a chat/task
 * provider key is added. With no requested model, Cloudflare auto-wires only
 * when no OpenAI or OpenRouter Memory key is set. Base `.../ai`.
 */
export async function resolveBrainEmbeddingsUpstream(
  requestedModel?: string,
): Promise<BrainEmbeddingsUpstream | null> {
  const cacheKey = requestedModel ?? '';
  const cached = upstreamCache;

  if (
    cached &&
    cached.expiresAtMs > Date.now() &&
    cached.values.has(cacheKey)
  ) {
    return cached.values.get(cacheKey)!;
  }

  const value = await readBrainEmbeddingsUpstream(requestedModel);

  if (!upstreamCache || upstreamCache.expiresAtMs <= Date.now()) {
    upstreamCache = {
      values: new Map(),
      expiresAtMs: Date.now() + UPSTREAM_CACHE_TTL_MS,
    };
  }

  upstreamCache.values.set(cacheKey, value);
  return value;
}

/**
 * Whether this deployment can embed Brain pages. An explicit upstream
 * URL wins; Cloudflare Workers AI auto-wires only with no OpenAI or
 * OpenRouter key; otherwise that provider key is required. Synthesis is
 * not part of this gate.
 */
export async function isBrainEmbeddingAvailable(): Promise<boolean> {
  if (await resolveBrainEmbeddingsUpstream()) {
    return true;
  }

  return Boolean(await resolveBrainInferenceProvider());
}
