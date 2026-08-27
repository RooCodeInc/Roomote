import {
  buildOpenAiCompatibleProviderInstance,
  getOpenAiCompatibleProviderInstance,
  isOpenAiCompatibleProviderId,
  listOpenAiCompatibleProviderInstancesFromEnvNames,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type OpenAiCompatibleProviderInstance,
} from './openai-compatible-providers';
import { ROOMOTE_INFERENCE_API_KEY_ENV_VAR_NAME } from './model-provider-config';

/** Fallback direct-mode base URL for default and named OpenAI-compatible ids. */
const OPENAI_COMPATIBLE_DEFAULT_FALLBACK_BASE_URL = 'http://127.0.0.1:4000/v1';

const DEFAULT_OPENAI_COMPATIBLE_INSTANCE =
  buildOpenAiCompatibleProviderInstance(null);

export const TASK_MODEL_CONTEXT_WINDOWS_ENV_VAR_NAME =
  'R_TASK_MODEL_CONTEXT_WINDOWS' as const;

export function parseTaskModelContextWindows(
  value: string | undefined,
): Record<string, number> {
  if (!value?.trim()) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([modelId, contextWindow]) =>
        modelId.includes('/') &&
        typeof contextWindow === 'number' &&
        Number.isSafeInteger(contextWindow) &&
        contextWindow > 0
          ? [[modelId, contextWindow]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

const STATIC_OPENAI_COMPATIBLE_PROVIDER_CONFIGS = {
  roomote: {
    name: 'Roomote inference',
    baseUrlEnvVarName: 'ROOMOTE_INFERENCE_BASE_URL',
    fallbackBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVarName: ROOMOTE_INFERENCE_API_KEY_ENV_VAR_NAME,
    keyless: false,
    allowOpenAiEnvFallback: false,
  },
  [OPENAI_COMPATIBLE_PROVIDER_ID]: {
    name: DEFAULT_OPENAI_COMPATIBLE_INSTANCE.label,
    baseUrlEnvVarName: DEFAULT_OPENAI_COMPATIBLE_INSTANCE.baseUrlEnvVarName,
    fallbackBaseUrl: OPENAI_COMPATIBLE_DEFAULT_FALLBACK_BASE_URL,
    apiKeyEnvVarName: DEFAULT_OPENAI_COMPATIBLE_INSTANCE.apiKeyEnvVarName as
      | string
      | undefined,
    keyless: false,
    // Arbitrary endpoints must not inherit OPENAI_* credentials.
    allowOpenAiEnvFallback: false,
  },
  ollama: {
    name: 'Ollama',
    baseUrlEnvVarName: 'OLLAMA_BASE_URL',
    fallbackBaseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyEnvVarName: undefined as string | undefined,
    keyless: true,
    allowOpenAiEnvFallback: false,
  },
  vllm: {
    name: 'vLLM',
    baseUrlEnvVarName: 'VLLM_BASE_URL',
    fallbackBaseUrl: 'http://127.0.0.1:8000/v1',
    apiKeyEnvVarName: 'VLLM_API_KEY' as string | undefined,
    keyless: false,
    allowOpenAiEnvFallback: true,
  },
  litellm: {
    name: 'LiteLLM',
    baseUrlEnvVarName: 'LITELLM_BASE_URL',
    fallbackBaseUrl: 'http://127.0.0.1:4000/v1',
    apiKeyEnvVarName: 'LITELLM_API_KEY' as string | undefined,
    keyless: false,
    allowOpenAiEnvFallback: true,
  },
} as const;

type StaticOpenAiCompatibleProviderId =
  keyof typeof STATIC_OPENAI_COMPATIBLE_PROVIDER_CONFIGS;

type OpenAiCompatibleProviderRuntimeConfig = {
  name: string;
  baseUrlEnvVarName: string;
  fallbackBaseUrl: string;
  apiKeyEnvVarName: string | undefined;
  keyless: boolean;
  allowOpenAiEnvFallback: boolean;
};

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function toNamedOpenAiCompatibleRuntimeConfig(
  instance: OpenAiCompatibleProviderInstance,
): OpenAiCompatibleProviderRuntimeConfig {
  return {
    name: instance.label,
    baseUrlEnvVarName: instance.baseUrlEnvVarName,
    fallbackBaseUrl: OPENAI_COMPATIBLE_DEFAULT_FALLBACK_BASE_URL,
    apiKeyEnvVarName: instance.apiKeyEnvVarName,
    keyless: false,
    allowOpenAiEnvFallback: false,
  };
}

function resolveNamedOpenAiCompatibleInstance(
  providerId: string,
  runtimeEnv: RuntimeEnv,
): OpenAiCompatibleProviderInstance | null {
  const instance = getOpenAiCompatibleProviderInstance(providerId);
  if (!instance?.slug) {
    return null;
  }

  if (!instance.labelEnvVarName) {
    return instance;
  }

  const label = runtimeEnv[instance.labelEnvVarName]?.trim();
  if (!label) {
    return instance;
  }

  return getOpenAiCompatibleProviderInstance(providerId, { label }) ?? instance;
}

export function getOpenAiCompatibleRuntimeConfigs(
  modelIds: Array<string | undefined>,
  runtimeEnv: RuntimeEnv,
): Map<string, OpenAiCompatibleProviderRuntimeConfig> {
  const configs = new Map<string, OpenAiCompatibleProviderRuntimeConfig>();

  for (const [providerId, provider] of Object.entries(
    STATIC_OPENAI_COMPATIBLE_PROVIDER_CONFIGS,
  ) as Array<
    [StaticOpenAiCompatibleProviderId, OpenAiCompatibleProviderRuntimeConfig]
  >) {
    configs.set(providerId, provider);
  }

  const candidateProviderIds = new Set<string>();

  for (const modelId of modelIds) {
    const providerId = modelId?.trim().split('/')[0];
    if (providerId && isOpenAiCompatibleProviderId(providerId)) {
      candidateProviderIds.add(providerId);
    }
  }

  for (const instance of listOpenAiCompatibleProviderInstancesFromEnvNames(
    Object.keys(runtimeEnv),
  )) {
    candidateProviderIds.add(instance.id);
  }

  for (const providerId of candidateProviderIds) {
    if (configs.has(providerId)) {
      continue;
    }

    const instance = resolveNamedOpenAiCompatibleInstance(
      providerId,
      runtimeEnv,
    );
    if (instance) {
      configs.set(providerId, toNamedOpenAiCompatibleRuntimeConfig(instance));
    }
  }

  return configs;
}

export function mergeOpenAiCompatibleProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
  modelIds: Array<string | undefined>,
  visionModel?: string,
  modelContextWindows: Readonly<Record<string, number>> = {},
): Record<string, unknown> {
  let merged = providerConfig;
  const runtimeConfigs = getOpenAiCompatibleRuntimeConfigs(
    modelIds,
    runtimeEnv,
  );

  for (const [providerId, provider] of runtimeConfigs) {
    const prefix = `${providerId}/`;
    const modelIdsForProvider = [
      ...new Set(
        modelIds.flatMap((modelId) => {
          const normalized = modelId?.trim();
          return normalized?.startsWith(prefix)
            ? [normalized.slice(prefix.length)]
            : [];
        }),
      ),
    ];

    if (modelIdsForProvider.length === 0) {
      continue;
    }

    const existingProvider = asRecord(merged[providerId]);
    const existingOptions = asRecord(existingProvider.options);
    const existingModels = asRecord(existingProvider.models);
    const directApiKey = provider.apiKeyEnvVarName
      ? runtimeEnv[provider.apiKeyEnvVarName]?.trim()
      : undefined;
    const baseURL =
      runtimeEnv[provider.baseUrlEnvVarName]?.trim() ||
      (provider.allowOpenAiEnvFallback
        ? runtimeEnv.OPENAI_BASE_URL?.trim()
        : '') ||
      provider.fallbackBaseUrl;
    const apiKeyOptions = directApiKey
      ? { apiKey: `{env:${provider.apiKeyEnvVarName}}` }
      : provider.keyless
        ? { apiKey: 'ollama' }
        : provider.allowOpenAiEnvFallback && runtimeEnv.OPENAI_API_KEY?.trim()
          ? { apiKey: '{env:OPENAI_API_KEY}' }
          : {};

    merged = {
      ...merged,
      [providerId]: {
        ...existingProvider,
        npm: '@ai-sdk/openai-compatible',
        name: provider.name,
        options: {
          ...existingOptions,
          baseURL,
          ...apiKeyOptions,
        },
        models: {
          ...existingModels,
          ...Object.fromEntries(
            modelIdsForProvider.map((modelId) => {
              const qualifiedModelId = `${providerId}/${modelId}`;
              const existingModel = asRecord(existingModels[modelId]);
              const contextWindow = modelContextWindows[qualifiedModelId];
              const existingLimit = asRecord(existingModel.limit);
              const existingOutputLimit = existingLimit.output;
              const outputLimit =
                typeof existingOutputLimit === 'number' &&
                Number.isSafeInteger(existingOutputLimit) &&
                existingOutputLimit > 0
                  ? existingOutputLimit
                  : contextWindow
                    ? Math.min(
                        32_000,
                        Math.max(1, Math.floor(contextWindow / 4)),
                      )
                    : undefined;

              return [
                modelId,
                {
                  name: modelId,
                  ...(visionModel === qualifiedModelId
                    ? {
                        attachment: true,
                        modalities: {
                          input: ['text', 'image', 'video'],
                          output: ['text'],
                        },
                      }
                    : {}),
                  ...existingModel,
                  ...(contextWindow && outputLimit
                    ? {
                        limit: {
                          ...existingLimit,
                          context: contextWindow,
                          output: outputLimit,
                        },
                      }
                    : {}),
                },
              ];
            }),
          ),
        },
      },
    };
  }

  return merged;
}
