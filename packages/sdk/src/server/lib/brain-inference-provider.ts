/**
 * Which provider the Brain's own inference runs through.
 *
 * The Brain holds no provider credential. Roomote resolves the key per
 * request from Settings first, then the deployment environment.
 */

import { resolveModelProviderEnvValue } from '@roomote/db/server';

export type BrainInferenceProviderId = 'openrouter' | 'openai';

export type ResolvedBrainInference = {
  providerId: BrainInferenceProviderId;
  apiKey: string;
};

/**
 * OpenRouter first mirrors the Brain container's default, so a deployment
 * with both keys behaves the same through the gateway or a direct call.
 */
const BRAIN_PROVIDER_PREFERENCE: readonly BrainInferenceProviderId[] = [
  'openrouter',
  'openai',
];

/** Brain-specific keys win so Memory can be billed apart from task inference. */
const BRAIN_PROVIDER_ENV_VAR_NAMES: Record<
  BrainInferenceProviderId,
  readonly string[]
> = {
  openrouter: ['R_BRAIN_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  openai: ['R_BRAIN_OPENAI_API_KEY', 'OPENAI_API_KEY'],
};

/**
 * Resolution reads persisted settings. A 30s cache keeps a backfill from
 * issuing a database round trip per page; rotating a key still takes effect
 * promptly.
 */
const PROVIDER_CACHE_TTL_MS = 30_000;

let providerCache: {
  value: ResolvedBrainInference | null;
  expiresAtMs: number;
} | null = null;

/** Drop the cached provider, so the next call re-reads settings. */
export function resetBrainInferenceProviderCache(): void {
  providerCache = null;
}

export async function resolveBrainInferenceProvider(): Promise<ResolvedBrainInference | null> {
  const cached = providerCache;

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.value;
  }

  const resolved = await readBrainInferenceProvider();

  providerCache = {
    value: resolved,
    expiresAtMs: Date.now() + PROVIDER_CACHE_TTL_MS,
  };

  return resolved;
}

async function readBrainInferenceProvider(): Promise<ResolvedBrainInference | null> {
  for (const providerId of BRAIN_PROVIDER_PREFERENCE) {
    const apiKey = await resolveModelProviderEnvValue(
      BRAIN_PROVIDER_ENV_VAR_NAMES[providerId],
    );

    if (apiKey?.trim()) {
      return { providerId, apiKey: apiKey.trim() };
    }
  }

  return null;
}
