import {
  getInferenceGatewayProvider,
  INFERENCE_GATEWAY_IDENTITY_PATTERN,
  INFERENCE_GATEWAY_RESOURCE_PATTERN,
  toCloudflareAiGatewayUpstreamModelId,
  type InferenceGatewayProvider,
} from './inference-gateway';
import { getSetupModelProvider } from './model-provider-config';
import {
  buildOpenAiCompatibleProviderInstance,
  getOpenAiCompatibleProviderInstance,
  isOpenAiCompatibleProviderId,
  listOpenAiCompatibleProviderInstancesFromEnvNames,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type OpenAiCompatibleProviderInstance,
} from './openai-compatible-providers';

/** Fallback direct-mode base URL for default and named OpenAI-compatible ids. */
const OPENAI_COMPATIBLE_DEFAULT_FALLBACK_BASE_URL = 'http://127.0.0.1:4000/v1';

const DEFAULT_OPENAI_COMPATIBLE_INSTANCE =
  buildOpenAiCompatibleProviderInstance(null);

const STATIC_OPENAI_COMPATIBLE_PROVIDER_CONFIGS = {
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
            modelIdsForProvider.map((modelId) => [
              modelId,
              {
                name: modelId,
                ...(visionModel === `${providerId}/${modelId}`
                  ? {
                      attachment: true,
                      modalities: {
                        input: ['text', 'image', 'video'],
                        output: ['text'],
                      },
                    }
                  : {}),
                ...asRecord(existingModels[modelId]),
              },
            ]),
          ),
        },
      },
    };
  }

  return merged;
}

const CLOUDFLARE_OPENCODE_PROVIDER_IDS = [
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
] as const;

function readRequiredEnv(
  runtimeEnv: RuntimeEnv,
  envVarName: string | undefined,
): string | undefined {
  return envVarName ? runtimeEnv[envVarName]?.trim() || undefined : undefined;
}

/**
 * Emit openai-compat providers against Cloudflare `/ai/v1` using Roomote's
 * namespaced env vars, not models.dev's shared `CLOUDFLARE_ACCOUNT_ID`. Used
 * by control-plane helpers and by direct-mode task execution when the
 * inference gateway is absent.
 */
export function mergeCloudflareOpenCodeProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  let merged = providerConfig;

  for (const providerId of CLOUDFLARE_OPENCODE_PROVIDER_IDS) {
    const gatewayProvider = getInferenceGatewayProvider(providerId);
    const setupProvider = getSetupModelProvider(providerId);

    if (!gatewayProvider?.resource || !setupProvider.envVarName) {
      continue;
    }

    const prefix = `${providerId}/`;
    const modelIdsForProvider = [
      ...new Set(
        modelIds.flatMap((modelId) => {
          const normalized = modelId?.trim();
          return normalized?.startsWith(prefix)
            ? [
                providerId === 'cloudflare-ai-gateway'
                  ? toCloudflareAiGatewayUpstreamModelId(
                      normalized.slice(prefix.length),
                    )
                  : normalized.slice(prefix.length),
              ]
            : [];
        }),
      ),
    ];

    if (modelIdsForProvider.length === 0) {
      continue;
    }

    const apiKey = readRequiredEnv(runtimeEnv, setupProvider.envVarName);
    const accountId = readRequiredEnv(
      runtimeEnv,
      gatewayProvider.resource.envVarName,
    );

    if (
      !apiKey ||
      !accountId ||
      !INFERENCE_GATEWAY_RESOURCE_PATTERN.test(accountId)
    ) {
      continue;
    }

    const existingProvider = asRecord(merged[providerId]);
    const existingOptions = asRecord(existingProvider.options);
    const existingModels = asRecord(existingProvider.models);
    const options: Record<string, unknown> = {
      ...existingOptions,
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      apiKey: `{env:${setupProvider.envVarName}}`,
    };

    if (
      !appendRequiredCloudflareHeaders(options, gatewayProvider, runtimeEnv)
    ) {
      continue;
    }

    merged = {
      ...merged,
      [providerId]: {
        ...existingProvider,
        npm: gatewayProvider.openCodeNpm ?? '@ai-sdk/openai-compatible',
        name: setupProvider.label,
        options,
        models: {
          ...existingModels,
          ...Object.fromEntries(
            modelIdsForProvider.map((modelId) => [
              modelId,
              {
                name: modelId,
                ...asRecord(existingModels[modelId]),
              },
            ]),
          ),
        },
      },
    };
  }

  return merged;
}

function appendRequiredCloudflareHeaders(
  options: Record<string, unknown>,
  gatewayProvider: InferenceGatewayProvider,
  runtimeEnv: RuntimeEnv,
): boolean {
  if (!gatewayProvider.requiredHeaders?.length) {
    return true;
  }

  const headers = {
    ...asRecord(options.headers),
  };

  for (const spec of gatewayProvider.requiredHeaders) {
    const value = readRequiredEnv(runtimeEnv, spec.envVarName);

    if (!value || !INFERENCE_GATEWAY_IDENTITY_PATTERN.test(value)) {
      return false;
    }

    headers[spec.headerName] = value;
  }

  options.headers = headers;
  return true;
}
