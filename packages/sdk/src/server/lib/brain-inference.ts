/**
 * Which provider the Brain's own inference runs through, and under which
 * model names.
 *
 * The Brain container holds no provider credential. It is configured with a
 * base URL pointing back at this deployment plus a shared gateway token, and
 * every embedding and synthesis call arrives at /api/brain/inference for
 * Roomote to forward. The real key is resolved here, per request, from
 * wherever an admin configured it: Settings first (encrypted in the database),
 * then the deployment's environment. Rotating it takes effect on the next
 * call, with no restart and no key ever reaching the Brain.
 */

import { readFileSync } from 'node:fs';

import { resolveModelProviderEnvValue } from '@roomote/db/server';
import { Env } from '@roomote/env';

/**
 * Same model under each provider's naming, so a request can be translated
 * without changing which model actually runs. `kind` matters: a chat model is
 * free to be overridden per deployment, an embedding model is not, because
 * its output width is baked into the Brain's vector column at creation.
 */
const MODEL_TRANSLATIONS: ReadonlyArray<{
  kind: 'embedding' | 'chat';
  openai: string;
  openrouter: string;
}> = [
  {
    kind: 'embedding',
    openai: 'text-embedding-3-small',
    openrouter: 'openai/text-embedding-3-small',
  },
  {
    kind: 'embedding',
    openai: 'text-embedding-3-large',
    openrouter: 'openai/text-embedding-3-large',
  },
  { kind: 'chat', openai: 'gpt-5.6-luna', openrouter: 'openai/gpt-5.6-luna' },
];

export type BrainInferenceProviderId = 'openrouter' | 'openai';

/**
 * Preference order when more than one provider is configured. OpenRouter
 * first mirrors the Brain container's own default, so a deployment that has
 * both keys behaves the same whether it routes through the gateway or (on the
 * env-var fallback path) talks to a provider directly.
 */
const BRAIN_PROVIDER_PREFERENCE: readonly BrainInferenceProviderId[] = [
  'openrouter',
  'openai',
];

/**
 * Brain-specific keys win over the deployment's general model-provider keys,
 * so an operator can bill the Brain separately from task inference without
 * the two settings fighting.
 */
const BRAIN_PROVIDER_ENV_VAR_NAMES: Record<
  BrainInferenceProviderId,
  readonly string[]
> = {
  openrouter: ['R_BRAIN_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  openai: ['R_BRAIN_OPENAI_API_KEY', 'OPENAI_API_KEY'],
};

/**
 * Resolution reads persisted deployment settings, so without this every
 * embedding call is a database round trip. A backfill embeds a page at a
 * time and would issue hundreds in a burst against the same database the
 * drainer is working. Short enough that rotating a key in Settings still
 * takes effect promptly; misses are cheap either way.
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

export type ResolvedBrainInference = {
  providerId: BrainInferenceProviderId;
  apiKey: string;
};

/**
 * Resolve the provider the Brain's inference should use right now, or null
 * when this deployment has no usable credential. Null is a normal state: it
 * means the Brain is deployed but nobody has configured a model provider yet.
 */
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

/**
 * Whether this deployment has a way to embed Brain pages at all — the
 * readiness bar for running collectors and draining the memory outbox.
 *
 * Provider-agnostic by design. A dedicated embedder is the normal path:
 * `R_BRAIN_EMBEDDINGS_UPSTREAM_URL` points embeddings at a self-run model
 * (the shared Modal endpoint for every hosting-managed tenant; the local
 * Infinity service for the self-host compose local-inference profile), so no
 * model-provider key is involved in embedding at all. Only when no embedder
 * is configured does this fall back to requiring an embeddings-capable
 * provider key (the direct self-host path, where OpenAI/OpenRouter does the
 * embedding).
 *
 * Synthesis is deliberately NOT part of this gate: it rides the deployment's
 * helper model through the inference gateway and therefore works with whatever
 * provider runs the deployment's tasks — Anthropic, OpenAI, OpenRouter, or a
 * minted trial key alike. Gating on an OpenAI/OpenRouter key would have locked
 * every Anthropic-only or trial tenant out of Memory even though both halves
 * of its inference are actually available.
 */
export async function isBrainEmbeddingAvailable(): Promise<boolean> {
  if (Env.R_BRAIN_EMBEDDINGS_UPSTREAM_URL?.trim()) {
    return true;
  }

  return Boolean(await resolveBrainInferenceProvider());
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

/**
 * Rewrite the model name the Brain asked for into the one this deployment
 * should actually call.
 *
 * Two things happen here. The Brain always speaks OpenAI's names because it
 * is configured as an OpenAI-compatible client, so its request is translated
 * onto whichever provider is serving it. And for the synthesis model only, an
 * operator override (`R_BRAIN_MODEL`, written in that provider's own naming)
 * wins outright, which is what makes the synthesis model a deployment setting
 * rather than a property of the Brain container.
 *
 * An unrecognized model with no override passes through untouched rather than
 * being rejected: an operator who set GBRAIN_MODEL on the container directly
 * has already taken ownership of matching it to their provider.
 */
export function mapBrainModelName(
  requested: string,
  resolved: ResolvedBrainInference,
): string {
  const normalized = requested.trim();
  const row = MODEL_TRANSLATIONS.find(
    (entry) => entry.openai === normalized || entry.openrouter === normalized,
  );

  if (!row) {
    return normalized;
  }

  // Deliberately no embedding override here. Which embedding model runs is
  // fixed when the Brain is created, because its output width sizes a vector
  // column that cannot be resized in place; substituting a different one at
  // request time would send vectors of the wrong width into that column. The
  // Brain is told its embedding model at init instead, and this only
  // translates the name it asks for into the serving provider's spelling.
  if (row.kind === 'chat') {
    const override = Env.R_BRAIN_MODEL?.trim();

    if (override) {
      return override;
    }
  }

  return resolved.providerId === 'openrouter' ? row.openrouter : row.openai;
}

export type BrainModelSummary = {
  /** In the serving provider's own naming, as the gateway will forward it. */
  synthesisModel: string;
  synthesisSource: 'default' | 'override';
  embeddingModel: string;
  /** Known for the stock embedding models; null for an operator's own. */
  embeddingDimensions: number | null;
};

/**
 * The models the Brain is effectively running, for display. Mirrors
 * `mapBrainModelName`: the synthesis model is whatever the override or the
 * translation table produces at forward time, while the embedding model is
 * whatever the container was told at init (`R_BRAIN_EMBEDDING_MODEL`, else
 * the stock default), which is why the Settings page presents it as fixed.
 */
export function describeBrainModels(
  providerId: BrainInferenceProviderId,
): BrainModelSummary {
  // Truthiness on the trimmed value, exactly like `mapBrainModelName`: a
  // whitespace-only override falls through to the default in both places.
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
  const embeddingDimensions =
    Env.R_BRAIN_EMBEDDING_DIMENSIONS ??
    (embeddingModel.includes('text-embedding-3-large')
      ? 3072
      : embeddingModel.includes('text-embedding-3-small')
        ? 1536
        : null);

  return {
    synthesisModel:
      override || (providerId === 'openrouter' ? chat.openrouter : chat.openai),
    synthesisSource: override ? 'override' : 'default',
    embeddingModel,
    embeddingDimensions,
  };
}

/**
 * The shared secret the Brain presents to /api/brain/inference. Absent means
 * the route is closed: a deployment without this configured has no Brain
 * calling it, and an unauthenticated request must never fall through to a
 * provider key.
 */
export function getBrainGatewayToken(): string | null {
  const direct = Env.R_BRAIN_GATEWAY_TOKEN?.trim();

  if (direct) {
    return direct;
  }

  // Compose brings the Brain up without anyone choosing a value: the
  // container writes one to its volume on first boot and the app services
  // mount that read-only. Absent simply means no Brain is wired up yet.
  if (Env.R_BRAIN_GATEWAY_TOKEN_FILE) {
    try {
      return (
        readFileSync(Env.R_BRAIN_GATEWAY_TOKEN_FILE, 'utf8').trim() || null
      );
    } catch {
      return null;
    }
  }

  return null;
}
