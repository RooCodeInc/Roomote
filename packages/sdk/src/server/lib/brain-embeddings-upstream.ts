import { resolveModelProviderEnvValue } from '@roomote/db/server';
import { Env } from '@roomote/env';

import { resolveBrainInferenceProvider } from './brain-inference-provider';

/** Workers AI account ids are 32 hex chars. */
const CLOUDFLARE_WORKERS_AI_ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;
const UPSTREAM_CACHE_TTL_MS = 30_000;

export const CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS = 1024;

export type BrainEmbeddingsUpstream = {
  baseUrl: string;
  apiKey?: string;
  source: 'configured' | 'cloudflare-workers-ai';
};

let upstreamCache: {
  value: BrainEmbeddingsUpstream | null;
  expiresAtMs: number;
} | null = null;

/** Drop the cached upstream so the next call re-reads settings. */
export function resetBrainEmbeddingsUpstreamCache(): void {
  upstreamCache = null;
}

/**
 * Where Memory embeddings are forwarded. `R_BRAIN_EMBEDDINGS_UPSTREAM_URL`
 * always wins. Cloudflare Workers AI auto-wires only when no OpenAI or
 * OpenRouter Memory key is set, so an existing OpenAI-model brain keeps
 * its provider path. Base `.../ai`; the gateway appends `/v1/embeddings`.
 */
export async function resolveBrainEmbeddingsUpstream(): Promise<BrainEmbeddingsUpstream | null> {
  const cached = upstreamCache;

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.value;
  }

  const value = await readBrainEmbeddingsUpstream();
  upstreamCache = { value, expiresAtMs: Date.now() + UPSTREAM_CACHE_TTL_MS };
  return value;
}

async function readBrainEmbeddingsUpstream(): Promise<BrainEmbeddingsUpstream | null> {
  const configured = Env.R_BRAIN_EMBEDDINGS_UPSTREAM_URL?.trim();

  if (configured) {
    return {
      baseUrl: configured.replace(/\/$/, ''),
      apiKey: Env.R_BRAIN_INFERENCE_UPSTREAM_API_KEY?.trim() || undefined,
      source: 'configured',
    };
  }

  if (await resolveBrainInferenceProvider()) {
    return null;
  }

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
    source: 'cloudflare-workers-ai',
  };
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
