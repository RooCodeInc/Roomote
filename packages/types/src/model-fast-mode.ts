import { z } from 'zod';

export const MODEL_FAST_MODE_OPTIONS_ENV_VAR_NAME = 'R_MODEL_FAST_MODE_OPTIONS';

export const MODEL_FAST_MODE_VALUES = ['inherit', 'normal', 'fast'] as const;
export const modelFastModeSchema = z.enum(MODEL_FAST_MODE_VALUES);
export type ModelFastMode = z.infer<typeof modelFastModeSchema>;

export const MODEL_FAST_MODE_AUTH_KINDS = [
  'chatgpt-oauth',
  'openai-api-key',
] as const;
export type ModelFastModeAuthKind = (typeof MODEL_FAST_MODE_AUTH_KINDS)[number];

export type OpenAiServiceTier = 'default' | 'priority';

export type ModelFastModeCapability = {
  id: string;
  providerId: 'openai';
  modelId: string;
  modelName: string;
  providerLabel: string;
  authKind: ModelFastModeAuthKind;
  endpoint: 'responses';
  request: {
    option: 'serviceTier';
    normal: OpenAiServiceTier;
    fast: OpenAiServiceTier;
  };
  inheritance: 'chatgpt-account' | 'provider-project';
  eligibilityDescription: string;
  response: {
    field: 'service_tier' | null;
    fastValues: readonly string[];
    standardValues: readonly string[];
  };
  fastDescription: string;
  inheritDescription: string;
};

const CHATGPT_FAST_MODEL_SLUGS = [
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
] as const;

const OPENAI_API_FAST_MODEL_SLUGS = [
  // Current OpenAI Fast mode pricing lists these model IDs. The direct
  // OpenAI Responses route in Roomote uses the same `service_tier` request
  // field and response signal for each listed model.
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-2024-05-13',
  'gpt-4o-mini',
  'o3',
  'o4-mini',
] as const;

const RESPONSE_FAST_VALUES = ['fast', 'priority'] as const;
const RESPONSE_STANDARD_VALUES = ['default'] as const;

function modelNameFromSlug(slug: string): string {
  if (/^o\d/u.test(slug)) {
    return slug.toUpperCase().replaceAll('-', ' ');
  }

  return slug
    .replace(/^gpt-/u, 'GPT-')
    .replace(/^5\./u, '5.')
    .replaceAll('-', ' ')
    .replace(
      /\b(astra|sol|luna|terra)\b/giu,
      (_, name: string) => name[0]!.toUpperCase() + name.slice(1),
    );
}

export const MODEL_FAST_MODE_CAPABILITIES: readonly ModelFastModeCapability[] =
  [
    ...CHATGPT_FAST_MODEL_SLUGS.map((slug) => ({
      id: `openai:chatgpt-oauth:${slug}:responses`,
      providerId: 'openai' as const,
      modelId: `openai/${slug}`,
      modelName: modelNameFromSlug(slug),
      providerLabel: 'ChatGPT subscription',
      authKind: 'chatgpt-oauth' as const,
      endpoint: 'responses' as const,
      request: {
        option: 'serviceTier' as const,
        normal: 'default' as const,
        fast: 'priority' as const,
      },
      inheritance: 'chatgpt-account' as const,
      eligibilityDescription:
        'Requires an eligible ChatGPT subscription plan and model access.',
      // The Codex gateway response currently does not expose a consistently
      // documented service-tier field. Keep the requested mode distinct from a
      // provider-confirmed result.
      response: {
        field: null,
        fastValues: RESPONSE_FAST_VALUES,
        standardValues: RESPONSE_STANDARD_VALUES,
      },
      fastDescription: 'Uses more ChatGPT credits for faster responses.',
      inheritDescription: 'Use the account-level ChatGPT Fast mode setting.',
    })),
    ...OPENAI_API_FAST_MODEL_SLUGS.map((slug) => ({
      id: `openai:openai-api-key:${slug}:responses`,
      providerId: 'openai' as const,
      modelId: `openai/${slug}`,
      modelName: modelNameFromSlug(slug),
      providerLabel: 'OpenAI API key',
      authKind: 'openai-api-key' as const,
      endpoint: 'responses' as const,
      request: {
        option: 'serviceTier' as const,
        normal: 'default' as const,
        fast: 'priority' as const,
      },
      inheritance: 'provider-project' as const,
      eligibilityDescription:
        'Requires OpenAI project Fast access; project region and data-residency rules can limit availability.',
      response: {
        field: 'service_tier' as const,
        fastValues: RESPONSE_FAST_VALUES,
        standardValues: RESPONSE_STANDARD_VALUES,
      },
      fastDescription:
        'Fast mode carries a model-specific per-token premium. OpenAI can serve Standard instead during a traffic ramp.',
      inheritDescription: 'Use the OpenAI project service-tier default.',
    })),
  ];

const MODEL_FAST_MODE_CAPABILITY_BY_ID = new Map(
  MODEL_FAST_MODE_CAPABILITIES.map((capability) => [capability.id, capability]),
);
const MODEL_FAST_MODE_MODEL_IDS = new Set(
  MODEL_FAST_MODE_CAPABILITIES.map((capability) => capability.modelId),
);

export function getModelFastModeCapability(
  capabilityId: string,
): ModelFastModeCapability | undefined {
  return MODEL_FAST_MODE_CAPABILITY_BY_ID.get(capabilityId);
}

export function getModelFastModeCapabilityForModel({
  authKind,
  modelId,
}: {
  authKind: ModelFastModeAuthKind;
  modelId: string;
}): ModelFastModeCapability | undefined {
  return MODEL_FAST_MODE_CAPABILITIES.find(
    (capability) =>
      capability.authKind === authKind && capability.modelId === modelId,
  );
}

/**
 * Resolve per-route selections to OpenCode's per-model serviceTier options.
 * ChatGPT's account default is inherited only by the OAuth route. OpenAI API
 * inheritance intentionally omits serviceTier so the project setting wins.
 */
export function resolveModelFastModeRequestOptions({
  authKind,
  overrides,
  chatgptAccountFastMode = false,
}: {
  authKind: ModelFastModeAuthKind;
  overrides: Record<string, ModelFastMode> | null | undefined;
  chatgptAccountFastMode?: boolean;
}): Record<string, OpenAiServiceTier> {
  const result: Record<string, OpenAiServiceTier> = {};

  for (const capability of MODEL_FAST_MODE_CAPABILITIES) {
    if (capability.authKind !== authKind) continue;

    const mode = overrides?.[capability.id] ?? 'inherit';
    const effectiveMode =
      mode === 'inherit' &&
      capability.inheritance === 'chatgpt-account' &&
      chatgptAccountFastMode
        ? 'fast'
        : mode;

    if (effectiveMode === 'inherit') continue;

    result[capability.modelId] = capability.request[effectiveMode];
  }

  return result;
}

export function parseModelFastModeRequestOptions(
  value: string | undefined,
): Record<string, OpenAiServiceTier> {
  if (!value) return {};

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([modelId, serviceTier]) =>
          MODEL_FAST_MODE_MODEL_IDS.has(modelId) &&
          (serviceTier === 'default' || serviceTier === 'priority'),
      ),
    ) as Record<string, OpenAiServiceTier>;
  } catch {
    return {};
  }
}

/** Merge route-validated service tiers into OpenCode's OpenAI model config. */
export function mergeOpenCodeModelFastModeOptions(
  providerConfig: Record<string, unknown>,
  serviceTiers: Record<string, OpenAiServiceTier>,
): Record<string, unknown> {
  let merged = providerConfig;

  for (const [modelId, serviceTier] of Object.entries(serviceTiers)) {
    if (!modelId.startsWith('openai/')) continue;

    const openCodeModelId = modelId.slice('openai/'.length);
    const providerEntry = asRecord(merged.openai);
    const models = asRecord(providerEntry.models);
    const model = asRecord(models[openCodeModelId]);
    const options = asRecord(model.options);

    merged = {
      ...merged,
      openai: {
        ...providerEntry,
        models: {
          ...models,
          [openCodeModelId]: {
            ...model,
            options: { ...options, serviceTier },
          },
        },
      },
    };
  }

  return merged;
}

export type FastModeResponseValidation =
  | 'confirmed-fast'
  | 'confirmed-normal'
  | 'served-standard'
  | 'unreported'
  | 'unexpected-tier';

/** Classify the provider's response signal for a selected route and request. */
export function validateModelFastModeResponse({
  capabilityId,
  requestedMode,
  reportedTier,
}: {
  capabilityId: string;
  requestedMode: ModelFastMode;
  reportedTier: string | null | undefined;
}): FastModeResponseValidation {
  const capability = getModelFastModeCapability(capabilityId);

  if (!capability || !capability.response.field || !reportedTier) {
    return 'unreported';
  }

  if (requestedMode === 'fast') {
    if (capability.response.fastValues.includes(reportedTier)) {
      return 'confirmed-fast';
    }
    if (capability.response.standardValues.includes(reportedTier)) {
      return 'served-standard';
    }
    return 'unexpected-tier';
  }

  if (requestedMode === 'normal') {
    return capability.response.standardValues.includes(reportedTier)
      ? 'confirmed-normal'
      : 'unexpected-tier';
  }

  return 'unreported';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
