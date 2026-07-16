import {
  GATEWAY_TASK_MODEL_PROVIDER_IDS,
  type TaskModelInputType,
  type TaskModelMetadata,
} from '@roomote/types';

const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';
const BEDROCK_MANTLE_PROVIDER_PREFIX = 'bedrock-mantle/';
const MODELS_DEV_CATALOG_CACHE_TTL_MS = 5 * 60 * 1_000;

let cachedModelsDevCatalog:
  | { catalog: ModelsDevCatalog; expiresAt: number }
  | undefined;

type ModelsDevModalities = {
  input?: string[];
  output?: string[];
};

type ModelsDevLimit = {
  context?: number;
  output?: number;
};

type ModelsDevCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
};

export type ModelsDevModelEntry = {
  id?: string;
  name?: string;
  family?: string;
  modalities?: ModelsDevModalities;
  limit?: ModelsDevLimit;
  cost?: ModelsDevCost;
  reasoning?: boolean;
  release_date?: string;
  tool_call?: boolean;
  status?: string;
};

type ModelsDevProviderEntry = {
  id?: string;
  models?: Record<string, ModelsDevModelEntry>;
};

type ModelsDevSuggestion = {
  slug: string;
  displayName: string;
};

type ModelsDevCatalogJson = {
  models?: Record<string, ModelsDevModelEntry>;
  providers?: Record<string, ModelsDevProviderEntry>;
};

export type ModelsDevCatalog = {
  models: Record<string, ModelsDevModelEntry>;
  providers: Record<string, ModelsDevProviderEntry>;
  gatewayModelsByLowerSlug: Record<string, Record<string, ModelsDevModelEntry>>;
};

const MODELS_DEV_MODALITY_ALIASES: Record<string, TaskModelInputType> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'sound',
  sound: 'sound',
  pdf: 'pdf',
  file: 'pdf',
};

const TASK_MODEL_INPUT_TYPE_ORDER: TaskModelInputType[] = [
  'text',
  'image',
  'video',
  'sound',
  'pdf',
];

function mapInputModalities(
  raw: string[] | undefined,
): TaskModelInputType[] | null {
  if (!raw || raw.length === 0) {
    return null;
  }
  const mapped = new Set(
    raw
      .map((modality) => MODELS_DEV_MODALITY_ALIASES[modality.toLowerCase()])
      .filter((value): value is TaskModelInputType => Boolean(value)),
  );
  if (mapped.size === 0) {
    return null;
  }
  return TASK_MODEL_INPUT_TYPE_ORDER.filter((type) => mapped.has(type));
}

function costPerMillionToPerToken(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value / 1_000_000;
}

type ExtractedMetadata = {
  metadata: Partial<TaskModelMetadata>;
  displayName?: string;
};

function extractMetadataFromEntry(
  entry: ModelsDevModelEntry | undefined,
): ExtractedMetadata {
  if (!entry) {
    return { metadata: {} };
  }
  const displayName = entry.name?.trim() || undefined;
  const contextWindow =
    typeof entry.limit?.context === 'number' && entry.limit.context > 0
      ? entry.limit.context
      : null;
  const inputTypes = mapInputModalities(entry.modalities?.input);
  const inputPricePerToken = costPerMillionToPerToken(entry.cost?.input);
  const outputPricePerToken = costPerMillionToPerToken(entry.cost?.output);
  const metadata: Partial<TaskModelMetadata> = {};
  if (contextWindow !== null) {
    metadata.contextWindow = contextWindow;
  }
  if (inputTypes !== null) {
    metadata.inputTypes = inputTypes;
  }
  if (inputPricePerToken !== null) {
    metadata.inputPricePerToken = inputPricePerToken;
  }
  if (outputPricePerToken !== null) {
    metadata.outputPricePerToken = outputPricePerToken;
  }
  if (typeof entry.reasoning === 'boolean') {
    metadata.supportsReasoning = entry.reasoning;
  }
  return { metadata, displayName };
}

export async function fetchModelsDevCatalog(
  signal?: AbortSignal,
  options?: { forceRefresh?: boolean },
): Promise<ModelsDevCatalog | null> {
  if (signal?.aborted) {
    return null;
  }

  const cachedCatalog = cachedModelsDevCatalog;

  if (
    !options?.forceRefresh &&
    cachedCatalog &&
    cachedCatalog.expiresAt > Date.now()
  ) {
    return cachedCatalog.catalog;
  }

  try {
    const response = await fetch(MODELS_DEV_CATALOG_URL, { signal });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as ModelsDevCatalogJson;
    const providers = payload.providers ?? {};
    const gatewayModelsByLowerSlug: Record<
      string,
      Record<string, ModelsDevModelEntry>
    > = {};
    for (const gatewayProviderId of GATEWAY_TASK_MODEL_PROVIDER_IDS) {
      const gatewayModels = providers[gatewayProviderId]?.models ?? {};
      const byLowerSlug: Record<string, ModelsDevModelEntry> = {};
      for (const [slug, entry] of Object.entries(gatewayModels)) {
        byLowerSlug[slug.toLowerCase()] = entry;
      }
      gatewayModelsByLowerSlug[gatewayProviderId] = byLowerSlug;
    }
    const catalog = {
      models: payload.models ?? {},
      providers,
      gatewayModelsByLowerSlug,
    };
    cachedModelsDevCatalog = {
      catalog,
      expiresAt: Date.now() + MODELS_DEV_CATALOG_CACHE_TTL_MS,
    };
    return catalog;
  } catch {
    return null;
  }
}

/**
 * Resolves the models.dev catalog slug for a Roomote task model id.
 * Strips a leading gateway provider prefix (`openrouter/`, `vercel/`,
 * `requesty/`, `baseten/`, `togetherai/`) and any leading `~` alias marker.
 * Mantle's `lab.model` identifiers are converted to models.dev's `lab/model`
 * slugs so metadata continues to resolve through the underlying model lab.
 */
export function resolveModelsDevSlug(modelId: string): string {
  let slug = modelId;
  for (const gatewayProviderId of GATEWAY_TASK_MODEL_PROVIDER_IDS) {
    const gatewayPrefix = `${gatewayProviderId}/`;
    if (slug.startsWith(gatewayPrefix)) {
      slug = slug.slice(gatewayPrefix.length);
      break;
    }
  }
  if (slug.startsWith('~')) {
    slug = slug.slice(1);
  }
  if (slug.startsWith(BEDROCK_MANTLE_PROVIDER_PREFIX)) {
    const mantleModelId = slug.slice(BEDROCK_MANTLE_PROVIDER_PREFIX.length);
    const labSeparatorIndex = mantleModelId.indexOf('.');
    if (labSeparatorIndex > 0) {
      return `${mantleModelId.slice(0, labSeparatorIndex)}/${mantleModelId.slice(labSeparatorIndex + 1)}`;
    }
  }
  return slug;
}

/**
 * Looks up model metadata for a single task model id from the models.dev catalog.
 * For gateway-routed models (OpenRouter, Vercel AI Gateway, Requesty, Baseten,
 * Together AI), prefers the gateway provider entry (which carries gateway
 * pricing).
 * Otherwise falls back to the provider-agnostic `models` map for
 * context/modalities and the matching lab provider for pricing.
 * Returns partial metadata plus an optional display name; never throws.
 */
export function lookupModelMetadataFromCatalog(
  catalog: ModelsDevCatalog,
  modelId: string,
): ExtractedMetadata {
  const slug = resolveModelsDevSlug(modelId);
  const gatewayProviderId = GATEWAY_TASK_MODEL_PROVIDER_IDS.find((providerId) =>
    modelId.startsWith(`${providerId}/`),
  );

  if (gatewayProviderId) {
    const gatewayEntry = extractMetadataFromEntry(
      catalog.gatewayModelsByLowerSlug[gatewayProviderId]?.[slug.toLowerCase()],
    );
    if (
      Object.keys(gatewayEntry.metadata ?? {}).length > 0 ||
      gatewayEntry.displayName
    ) {
      return gatewayEntry;
    }
  }

  const genericEntry = extractMetadataFromEntry(catalog.models[slug]);
  const lab = slug.split('/')[0];
  const bareModelSlug = slug.split('/').slice(1).join('/');
  const labProviderEntry = lab
    ? (catalog.providers[lab]?.models?.[slug] ??
      (bareModelSlug
        ? catalog.providers[lab]?.models?.[bareModelSlug]
        : undefined))
    : undefined;
  const labPricing = extractMetadataFromEntry(labProviderEntry);

  const mergedMetadata: Partial<TaskModelMetadata> = {
    ...labPricing.metadata,
    ...genericEntry.metadata,
  };

  return {
    metadata: mergedMetadata,
    displayName: genericEntry.displayName ?? labPricing.displayName,
  };
}

export function mergeMetadata(
  base: TaskModelMetadata | null | undefined,
  patch: Partial<TaskModelMetadata>,
): TaskModelMetadata {
  const supportsReasoning = patch.supportsReasoning ?? base?.supportsReasoning;

  return {
    contextWindow: patch.contextWindow ?? base?.contextWindow ?? null,
    inputTypes: patch.inputTypes ?? base?.inputTypes ?? null,
    inputPricePerToken:
      patch.inputPricePerToken ?? base?.inputPricePerToken ?? null,
    outputPricePerToken:
      patch.outputPricePerToken ?? base?.outputPricePerToken ?? null,
    lastRefreshedAt: base?.lastRefreshedAt ?? null,
    ...(supportsReasoning != null ? { supportsReasoning } : {}),
  };
}

export function suggestModelsFromCatalog(options: {
  catalog: ModelsDevCatalog;
  providerId: string;
  query: string;
  limit?: number;
}): ModelsDevSuggestion[] {
  const normalizedQuery = options.query.trim().toLowerCase();

  if (normalizedQuery.length < 1) {
    return [];
  }

  const providerModels =
    options.catalog.providers[options.providerId]?.models ?? {};
  const rankedSuggestions = Object.entries(providerModels)
    .map(([slug, entry]) => {
      const trimmedSlug = slug.trim();
      const displayName = entry.name?.trim() || trimmedSlug;
      const lowerSlug = trimmedSlug.toLowerCase();
      const lowerName = displayName.toLowerCase();

      let rank: number | null = null;

      if (lowerSlug === normalizedQuery) {
        rank = 0;
      } else if (lowerName === normalizedQuery) {
        rank = 1;
      } else if (lowerSlug.startsWith(normalizedQuery)) {
        rank = 2;
      } else if (lowerName.startsWith(normalizedQuery)) {
        rank = 3;
      } else if (lowerSlug.includes(normalizedQuery)) {
        rank = 4;
      } else if (lowerName.includes(normalizedQuery)) {
        rank = 5;
      } else {
        const fuzzySlugRank = getFuzzyMatchRank(lowerSlug, normalizedQuery);
        const fuzzyNameRank = getFuzzyMatchRank(lowerName, normalizedQuery);

        if (fuzzySlugRank !== null || fuzzyNameRank !== null) {
          rank =
            6 +
            Math.min(
              fuzzySlugRank ?? Number.POSITIVE_INFINITY,
              fuzzyNameRank ?? Number.POSITIVE_INFINITY,
            );
        }
      }

      if (rank === null) {
        return null;
      }

      return {
        slug: trimmedSlug,
        displayName,
        rank,
      };
    })
    .filter(
      (entry): entry is ModelsDevSuggestion & { rank: number } =>
        entry !== null,
    )
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }

      return left.slug.localeCompare(right.slug);
    });

  const seenSlugs = new Set<string>();

  return rankedSuggestions
    .filter((entry) => {
      const normalizedSlug = entry.slug.toLowerCase();

      if (seenSlugs.has(normalizedSlug)) {
        return false;
      }

      seenSlugs.add(normalizedSlug);
      return true;
    })
    .slice(0, options.limit ?? 8)
    .map(({ slug, displayName }) => ({ slug, displayName }));
}

function getFuzzyMatchRank(candidate: string, query: string): number | null {
  let candidateIndex = 0;
  let previousMatchIndex = -1;
  let rank = 0;

  for (const queryCharacter of query) {
    const matchIndex = candidate.indexOf(queryCharacter, candidateIndex);

    if (matchIndex === -1) {
      return null;
    }

    if (previousMatchIndex >= 0) {
      rank += matchIndex - previousMatchIndex - 1;
    } else {
      rank += matchIndex;
    }

    previousMatchIndex = matchIndex;
    candidateIndex = matchIndex + 1;
  }

  return rank;
}
