import {
  SETUP_MODEL_PROVIDER_CATALOG,
  buildTaskModelOption,
  getModelProviderLabel,
  getSetupModelProvider,
  getSetupModelProviderAdditionalEnvFields,
  type SetupModelProviderId,
  type TaskModelMetadata,
} from '@roomote/types';

import { getPersistedEnvironmentVariableValues } from '../environment-variables';
import { mergeMetadata } from './models-dev';

const LOCAL_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

const LOCAL_ENDPOINT_PROVIDER_CATALOG = SETUP_MODEL_PROVIDER_CATALOG.filter(
  (
    provider,
  ): provider is (typeof SETUP_MODEL_PROVIDER_CATALOG)[number] & {
    authKind: 'endpoint';
    dynamicModels: true;
    envVarName: string;
  } =>
    provider.authKind === 'endpoint' &&
    provider.dynamicModels === true &&
    typeof provider.envVarName === 'string',
);

export const LOCAL_TASK_MODEL_PROVIDER_IDS =
  LOCAL_ENDPOINT_PROVIDER_CATALOG.map((provider) => provider.id) as [
    (typeof LOCAL_ENDPOINT_PROVIDER_CATALOG)[number]['id'],
    ...(typeof LOCAL_ENDPOINT_PROVIDER_CATALOG)[number]['id'][],
  ];

export type LocalTaskModelProviderId =
  (typeof LOCAL_TASK_MODEL_PROVIDER_IDS)[number];

export type LocalProviderConnectionInput = {
  baseUrl?: string;
  apiKey?: string;
};

type LocalProviderConnection = {
  baseUrl: string;
  apiKey: string | null;
};

type LocalProviderModelResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    model?: string;
    model_name?: string;
    model_info?: Record<string, unknown>;
  }>;
  models?: Array<{
    id?: string;
    name?: string;
    model?: string;
    model_name?: string;
    model_info?: Record<string, unknown>;
  }>;
  model_info?: Record<string, Record<string, unknown>>;
};

const LOCAL_MODEL_RECOMMENDATION_FAMILIES = [
  { pattern: /qwen(?:[\d.-]*)(?:[-_:]?(?:coder|code))?/i, score: 100 },
  { pattern: /devstral/i, score: 98 },
  { pattern: /gpt-oss/i, score: 96 },
  { pattern: /glm/i, score: 92 },
  { pattern: /mistral/i, score: 88 },
  { pattern: /deepseek/i, score: 86 },
  { pattern: /llama/i, score: 82 },
  { pattern: /gemma/i, score: 76 },
] as const;

const UNSUITABLE_LOCAL_MODEL_PATTERN =
  /(?:^|[-_:/.])(tiny|embed(?:ding)?|rerank(?:er)?|guard|moderation|vision|vl|ocr|whisper|tts|nomic|all-minilm)(?:$|[-_:/.])/i;
const LOCAL_MODEL_PARAMETER_COUNT_PATTERN =
  /(?:^|[-_:/.])(\d+(?:\.\d+)?)b(?:$|[-_:/.])/i;

export type TaskModelLookupResult = {
  modelId: string;
  displayName: string | null;
  family: string | null;
  metadata: TaskModelMetadata | null;
};

type LocalProviderDiscoveryResult = {
  models: TaskModelLookupResult[];
  modelCount: number;
  recommendedModels: TaskModelLookupResult[];
  error: string | null;
};

function isLocalTaskModelProviderId(
  providerId: string,
): providerId is LocalTaskModelProviderId {
  return LOCAL_TASK_MODEL_PROVIDER_IDS.includes(
    providerId as LocalTaskModelProviderId,
  );
}

export function getLocalTaskModelProviderIdFromModelId(
  modelId: string,
): LocalTaskModelProviderId | null {
  const providerId = modelId.split('/')[0];
  return providerId && isLocalTaskModelProviderId(providerId)
    ? providerId
    : null;
}

function getLocalProviderConnectionEnv(provider: LocalTaskModelProviderId): {
  baseUrl: string;
  apiKey?: string;
} {
  const descriptor = getSetupModelProvider(provider as SetupModelProviderId);
  const baseUrl = descriptor.envVarName;
  if (!baseUrl) {
    throw new Error(`Endpoint provider ${provider} is missing envVarName`);
  }

  const apiKeyField = getSetupModelProviderAdditionalEnvFields(descriptor).find(
    (field) => field.secret,
  );

  return {
    baseUrl,
    ...(apiKeyField ? { apiKey: apiKeyField.envVarName } : {}),
  };
}

function getLocalModelRecommendationScore(model: TaskModelLookupResult) {
  const name = `${model.modelId} ${model.displayName ?? ''}`.toLowerCase();

  if (UNSUITABLE_LOCAL_MODEL_PATTERN.test(name)) {
    return null;
  }

  const family = LOCAL_MODEL_RECOMMENDATION_FAMILIES.find(({ pattern }) =>
    pattern.test(name),
  );
  if (!family) {
    return null;
  }

  const parameterCount = Number(
    LOCAL_MODEL_PARAMETER_COUNT_PATTERN.exec(name)?.[1] ?? 0,
  );
  if (parameterCount > 0 && parameterCount < 7) {
    return null;
  }

  const codingBonus = /(?:coder|code)/i.test(name) ? 8 : 0;
  return family.score + codingBonus + Math.min(parameterCount, 100) / 100;
}

/**
 * Endpoint providers advertise their installed models rather than a stable
 * catalog. Keep the automatic choice deliberately conservative: only known
 * general-purpose families are eligible, and small or specialized models are
 * left for an operator to enable manually from Models settings.
 */
export function getRecommendedLocalProviderModels(
  models: readonly TaskModelLookupResult[],
) {
  return models
    .flatMap((model) => {
      const score = getLocalModelRecommendationScore(model);
      return score === null ? [] : [{ model, score }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.model.modelId.localeCompare(right.model.modelId),
    )
    .map(({ model }) => model);
}

function getLocalProviderBaseUrl(baseUrl: string, path: string) {
  const normalized = baseUrl.replace(/\/+$/u, '');
  const withoutV1 = normalized.endsWith('/v1')
    ? normalized.slice(0, -'/v1'.length)
    : normalized;

  return path.startsWith('/v1/')
    ? `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}${path.slice('/v1'.length)}`
    : `${withoutV1}${path}`;
}

function getLocalProviderError(
  provider: LocalTaskModelProviderId,
  response: Response,
) {
  const label = getModelProviderLabel(provider);

  if (response.status === 401 || response.status === 403) {
    return `${label} rejected the API key. Check the saved credentials.`;
  }
  if (response.status === 404) {
    return `${label} did not recognize this endpoint. Check the endpoint URL and API compatibility.`;
  }
  if (response.status === 429) {
    return `${label} is rate limiting requests. Try again shortly.`;
  }
  if (response.status >= 500) {
    return `${label} returned a server error (${response.status}). Check that the provider is healthy.`;
  }
  return `${label} returned HTTP ${response.status}.`;
}

function getLocalProviderNetworkError(provider: LocalTaskModelProviderId) {
  const label = getModelProviderLabel(provider);
  return `Could not reach ${label}. Check the endpoint URL and network access from Roomote.`;
}

async function getQualificationError(
  provider: LocalTaskModelProviderId,
  response: Response,
) {
  const baseError = getLocalProviderError(provider, response);
  if (response.status !== 400 && response.status !== 422) {
    return baseError;
  }

  try {
    const body = (await response.text()).trim();
    if (!body) {
      return baseError;
    }
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown };
      detail?: unknown;
    };
    const detail =
      (typeof parsed.error?.message === 'string' && parsed.error.message) ||
      (typeof parsed.detail === 'string' && parsed.detail) ||
      body;
    return `${baseError} ${detail.slice(0, 300)}`;
  } catch {
    return baseError;
  }
}

async function resolveLocalProviderConnection(
  provider: LocalTaskModelProviderId,
  input?: LocalProviderConnectionInput,
): Promise<LocalProviderConnection | null> {
  const envNames = getLocalProviderConnectionEnv(provider);
  const persisted = await getPersistedEnvironmentVariableValues([
    envNames.baseUrl,
    ...(envNames.apiKey ? [envNames.apiKey] : []),
  ]);
  const baseUrl =
    input?.baseUrl?.trim() ||
    process.env[envNames.baseUrl]?.trim() ||
    persisted[envNames.baseUrl]?.trim();

  if (!baseUrl) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    baseUrl,
    apiKey:
      input?.apiKey?.trim() ||
      (envNames.apiKey ? process.env[envNames.apiKey] : null) ||
      (envNames.apiKey ? persisted[envNames.apiKey] : null) ||
      null,
  };
}

function buildLocalProviderHeaders(connection: LocalProviderConnection) {
  return connection.apiKey
    ? { Authorization: `Bearer ${connection.apiKey}` }
    : undefined;
}

function getNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function buildLocalProviderModel(
  provider: LocalTaskModelProviderId,
  slug: string,
  displayName?: string,
  info?: Record<string, unknown>,
): TaskModelLookupResult {
  const metadataPatch = {
    contextWindow:
      getNumber(info?.max_input_tokens) ??
      getNumber(info?.max_tokens) ??
      getNumber(info?.context_window),
    inputPricePerToken: getNumber(info?.input_cost_per_token),
    outputPricePerToken: getNumber(info?.output_cost_per_token),
  };
  const hasMetadata = Object.values(metadataPatch).some(
    (value) => value !== null,
  );
  const model = buildTaskModelOption({
    id: `${provider}/${slug}`,
    displayName: displayName?.trim() || slug,
    metadata: hasMetadata ? mergeMetadata(null, metadataPatch) : null,
  });

  return {
    modelId: model.id,
    displayName: model.displayName,
    family: model.family,
    metadata: model.metadata ?? null,
  };
}

async function fetchLocalProviderModels(
  provider: LocalTaskModelProviderId,
  connection: LocalProviderConnection,
): Promise<LocalProviderDiscoveryResult> {
  const paths =
    provider === 'ollama' ? ['/api/tags', '/v1/models'] : ['/v1/models'];
  let lastError: string | null = null;

  for (const path of paths) {
    try {
      const response = await fetch(
        getLocalProviderBaseUrl(connection.baseUrl, path),
        {
          headers: buildLocalProviderHeaders(connection),
          signal: AbortSignal.timeout(LOCAL_PROVIDER_REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        lastError = getLocalProviderError(provider, response);
        continue;
      }

      const payload = (await response.json()) as LocalProviderModelResponse;
      let litellmModelInfo = payload.model_info;
      if (provider === 'litellm') {
        try {
          const infoResponse = await fetch(
            getLocalProviderBaseUrl(connection.baseUrl, '/model/info'),
            {
              headers: buildLocalProviderHeaders(connection),
              signal: AbortSignal.timeout(LOCAL_PROVIDER_REQUEST_TIMEOUT_MS),
            },
          );
          if (infoResponse.ok) {
            const infoPayload =
              (await infoResponse.json()) as LocalProviderModelResponse;
            const infoEntries = Object.fromEntries(
              (infoPayload.data ?? []).flatMap((entry) => {
                const modelName = entry.model_name ?? entry.id;
                return modelName && entry.model_info
                  ? [[modelName, entry.model_info]]
                  : [];
              }),
            );
            litellmModelInfo = {
              ...litellmModelInfo,
              ...infoPayload.model_info,
              ...infoEntries,
            };
          }
        } catch {
          // LiteLLM's metadata endpoint is optional; model discovery still works.
        }
      }
      const entries = path === '/api/tags' ? payload.models : payload.data;
      const models = (entries ?? [])
        .map((entry) => {
          const slug =
            entry.id?.trim() ||
            entry.name?.trim() ||
            entry.model?.trim() ||
            entry.model_name?.trim();
          return slug
            ? buildLocalProviderModel(
                provider,
                slug,
                entry.model_name ?? entry.name,
                entry.model_info ?? litellmModelInfo?.[slug],
              )
            : null;
        })
        .filter((model): model is TaskModelLookupResult => model !== null)
        .sort((left, right) => left.modelId.localeCompare(right.modelId));

      return {
        models,
        modelCount: models.length,
        recommendedModels: getRecommendedLocalProviderModels(models),
        error: null,
      };
    } catch {
      lastError = getLocalProviderNetworkError(provider);
    }
  }

  return {
    models: [],
    modelCount: 0,
    recommendedModels: [],
    error: lastError ?? getLocalProviderNetworkError(provider),
  };
}

export async function discoverProviderModels(
  input: { provider: LocalTaskModelProviderId } & LocalProviderConnectionInput,
): Promise<LocalProviderDiscoveryResult> {
  const connection = await resolveLocalProviderConnection(
    input.provider,
    input,
  );

  if (!connection) {
    return {
      models: [],
      modelCount: 0,
      recommendedModels: [],
      error: 'Save a valid endpoint URL before discovering models.',
    };
  }

  return fetchLocalProviderModels(input.provider, connection);
}

export async function qualifyProviderModel(
  input: {
    provider: LocalTaskModelProviderId;
    modelId: string;
  } & LocalProviderConnectionInput,
): Promise<{ success: true } | { success: false; error: string }> {
  const connection = await resolveLocalProviderConnection(
    input.provider,
    input,
  );
  const modelId = input.modelId.trim();

  if (!connection) {
    return {
      success: false,
      error: 'Save a valid endpoint URL before qualifying a model.',
    };
  }
  if (!modelId) {
    return { success: false, error: 'Choose a model before qualifying it.' };
  }

  try {
    const response = await fetch(
      getLocalProviderBaseUrl(connection.baseUrl, '/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildLocalProviderHeaders(connection),
        },
        body: JSON.stringify({
          model: modelId.replace(`${input.provider}/`, ''),
          messages: [{ role: 'user', content: 'Reply with pong.' }],
          stream: true,
          tool_choice: {
            type: 'function',
            function: { name: 'ping' },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'ping',
                description: 'Returns a short health-check response.',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(LOCAL_PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return {
        success: false,
        error: await getQualificationError(input.provider, response),
      };
    }

    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      return {
        success: false,
        error:
          'The provider returned a non-streaming response. Check OpenAI-compatible streaming support.',
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        success: false,
        error:
          'The provider accepted the request but did not return a streaming response body.',
      };
    }

    const decoder = new TextDecoder();
    let streamText = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        streamText += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }

    if (
      !streamText.includes('"tool_calls"') ||
      !streamText.includes('"ping"')
    ) {
      return {
        success: false,
        error:
          'The model streamed a response but did not call the required tool. Choose a model with OpenAI-compatible tool calling.',
      };
    }
    return { success: true };
  } catch {
    return {
      success: false,
      error: getLocalProviderNetworkError(input.provider),
    };
  }
}
