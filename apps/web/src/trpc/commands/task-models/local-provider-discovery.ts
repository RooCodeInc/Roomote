import { z } from 'zod';

import {
  SETUP_MODEL_PROVIDER_CATALOG,
  buildTaskModelOption,
  getModelProviderLabel,
  getSetupModelProvider,
  getSetupModelProviderAdditionalEnvFields,
  isOpenAiCompatibleProviderId,
  getOpenAiCompatibleProviderInstance,
  resolveOpenAiCompatibleProtocol,
  type OpenAiCompatibleProtocol,
  isSetupModelProviderId,
  type SetupModelProviderId,
  type TaskModelMetadata,
} from '@roomote/types';

import { getPersistedEnvironmentVariableValues } from '../environment-variables';
import { mergeMetadata } from './models-dev';

const LOCAL_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

const qualificationChunkSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative().optional(),
      delta: z.object({
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().nonnegative().optional(),
              id: z.string().optional(),
              function: z
                .object({
                  name: z.string().optional(),
                  arguments: z.string().optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    }),
  ),
});

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
  | (typeof LOCAL_TASK_MODEL_PROVIDER_IDS)[number]
  | `openai-compatible-${string}`;

export type LocalProviderConnectionInput = {
  protocol?: OpenAiCompatibleProtocol;
  baseUrl?: string;
  /** `null` marks a key the caller is clearing: the still-persisted value
   * must not serve as a fallback, because the save is about to delete it. */
  apiKey?: string | null;
};

type LocalProviderConnection = {
  protocol: OpenAiCompatibleProtocol;
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
  failureReason:
    | 'invalid_credentials'
    | 'insufficient_credits'
    | 'invalid_endpoint'
    | 'endpoint_not_found'
    | 'rate_limited'
    | 'provider_unavailable'
    | 'endpoint_unreachable'
    | null;
};

function isLocalTaskModelProviderId(
  providerId: string,
): providerId is LocalTaskModelProviderId {
  if (
    LOCAL_TASK_MODEL_PROVIDER_IDS.includes(
      providerId as (typeof LOCAL_TASK_MODEL_PROVIDER_IDS)[number],
    )
  ) {
    return true;
  }

  return isOpenAiCompatibleProviderId(providerId);
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
  const descriptor = getSetupModelProvider(
    isSetupModelProviderId(provider)
      ? provider
      : (provider as SetupModelProviderId),
  );
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
  if (response.status === 402) {
    return `${label} does not have enough credits or quota.`;
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

function getLocalProviderFailureReason(
  response: Response,
): Exclude<LocalProviderDiscoveryResult['failureReason'], null> {
  if (response.status === 401 || response.status === 403) {
    return 'invalid_credentials';
  }
  if (response.status === 402) {
    return 'insufficient_credits';
  }
  if (response.status === 404) {
    return 'endpoint_not_found';
  }
  if (response.status === 429) {
    return 'rate_limited';
  }
  return 'provider_unavailable';
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
  const instance = getOpenAiCompatibleProviderInstance(provider);
  const persisted = await getPersistedEnvironmentVariableValues([
    envNames.baseUrl,
    ...(instance ? [instance.protocolEnvVarName] : []),
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

  // A cleared key still resolves from the runtime env (deleting the
  // persisted row does not unset a process-level value), but must not fall
  // back to the persisted value the save is about to delete.
  const clearingApiKey = input?.apiKey === null;

  return {
    baseUrl,
    protocol: resolveOpenAiCompatibleProtocol(
      input?.protocol ??
        (instance
          ? (process.env[instance.protocolEnvVarName] ??
            persisted[instance.protocolEnvVarName])
          : undefined),
    ),
    apiKey:
      (clearingApiKey ? undefined : input?.apiKey?.trim()) ||
      (envNames.apiKey ? process.env[envNames.apiKey] : null) ||
      (envNames.apiKey && !clearingApiKey
        ? persisted[envNames.apiKey]
        : null) ||
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
  let lastFailureReason: LocalProviderDiscoveryResult['failureReason'] = null;
  let blockingError: string | null = null;
  let blockingFailureReason: Extract<
    LocalProviderDiscoveryResult['failureReason'],
    'invalid_credentials' | 'insufficient_credits'
  > | null = null;

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
        lastFailureReason = getLocalProviderFailureReason(response);
        if (
          lastFailureReason === 'invalid_credentials' ||
          lastFailureReason === 'insufficient_credits'
        ) {
          blockingError = lastError;
          blockingFailureReason = lastFailureReason;
        }
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
        failureReason: null,
      };
    } catch {
      lastError = getLocalProviderNetworkError(provider);
      lastFailureReason = 'endpoint_unreachable';
    }
  }

  return {
    models: [],
    modelCount: 0,
    recommendedModels: [],
    error: blockingError ?? lastError ?? getLocalProviderNetworkError(provider),
    failureReason:
      blockingFailureReason ?? lastFailureReason ?? 'endpoint_unreachable',
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
      failureReason: 'invalid_endpoint',
    };
  }

  return fetchLocalProviderModels(input.provider, connection);
}

const responsesEventSchema = z.object({
  type: z.string(),
  response: z
    .object({
      status: z.string().optional(),
      output: z
        .array(
          z
            .object({
              type: z.string(),
              call_id: z.string().optional(),
              name: z.string().optional(),
              arguments: z.string().optional(),
              content: z
                .array(
                  z.object({ type: z.string(), text: z.string().optional() }),
                )
                .optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .optional(),
});

async function readQualificationEvents(response: Response): Promise<unknown[]> {
  if (
    !response.headers.get('content-type')?.includes('text/event-stream') ||
    !response.body
  ) {
    throw new Error(
      'The provider did not return a streaming response. Check the selected API protocol and streaming support.',
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > 1_000_000)
        throw new Error('The qualification stream exceeded its size limit.');
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return text.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data.trim() === '[DONE]') return [];
    try {
      return [JSON.parse(data) as unknown];
    } catch {
      return [];
    }
  });
}

async function qualifyResponsesModel(
  provider: LocalTaskModelProviderId,
  modelId: string,
  connection: LocalProviderConnection,
): Promise<{ success: true } | { success: false; error: string }> {
  const prompt = {
    role: 'user',
    content: 'Call ping, then reply with the tool result.',
  };
  const request = async (input: unknown[], toolChoice: 'required' | 'none') => {
    const response = await fetch(
      getLocalProviderBaseUrl(connection.baseUrl, '/v1/responses'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildLocalProviderHeaders(connection),
        },
        body: JSON.stringify({
          model: modelId.replace(`${provider}/`, ''),
          stream: true,
          store: false,
          input,
          tool_choice: toolChoice,
          tools: [
            {
              type: 'function',
              name: 'ping',
              description: 'Returns a short health-check response.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
              strict: true,
            },
          ],
        }),
        signal: AbortSignal.timeout(LOCAL_PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok)
      throw new Error(
        `Responses API (/v1/responses): ${await getQualificationError(provider, response)}`,
      );
    const events = await readQualificationEvents(response);
    if (
      events.some((event) => {
        const parsed = responsesEventSchema.safeParse(event);
        return (
          parsed.success &&
          ['error', 'response.failed', 'response.incomplete'].includes(
            parsed.data.type,
          )
        );
      })
    )
      throw new Error('Responses API stream failed or was incomplete.');
    // The completed event contains the assembled function arguments and output,
    // independent of arbitrary network and argument-delta fragmentation.
    const completed = events
      .map((event) => responsesEventSchema.safeParse(event))
      .find(
        (event) => event.success && event.data.type === 'response.completed',
      );
    if (
      !completed?.success ||
      completed.data.response?.status !== 'completed'
    ) {
      throw new Error('Responses API stream did not complete.');
    }
    return completed.data.response.output ?? [];
  };
  try {
    const output = await request([prompt], 'required');
    const calls = output.filter((item) => item.type === 'function_call');
    if (
      !calls.length ||
      calls.some(
        (call) => call.name !== 'ping' || !call.call_id || !call.arguments,
      )
    ) {
      throw new Error(
        'The model streamed a response but did not call the required tool with a call ID and arguments.',
      );
    }
    for (const call of calls) {
      const args: unknown = JSON.parse(call.arguments!);
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('The model returned invalid tool arguments.');
    }
    const continuation = await request(
      [
        prompt,
        ...output,
        ...calls.map((call) => ({
          type: 'function_call_output',
          call_id: call.call_id,
          output: 'pong',
        })),
      ],
      'none',
    );
    if (
      !continuation.some(
        (item) =>
          item.type === 'message' &&
          item.content?.some(
            (part) => part.type === 'output_text' && part.text?.trim(),
          ),
      )
    ) {
      throw new Error(
        'Responses API tool output continuation completed without a text response.',
      );
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Responses API qualification failed.',
    };
  }
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
    if (connection.protocol === 'responses') {
      return await qualifyResponsesModel(input.provider, modelId, connection);
    }
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
          tool_choice: 'required',
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

    const initialEvents = await readQualificationEvents(response);
    const toolCalls = new Map<
      string,
      {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }
    >();
    for (const event of initialEvents) {
      const chunk = qualificationChunkSchema.safeParse(event);
      if (!chunk.success) continue;

      chunk.data.choices.forEach((choice, choiceOffset) => {
        choice.delta.tool_calls?.forEach((call, callOffset) => {
          const key = `${choice.index ?? choiceOffset}:${call.index ?? callOffset}`;
          // Function names may arrive in fragments across streamed deltas.
          const previous = toolCalls.get(key) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          toolCalls.set(key, {
            ...previous,
            id: previous.id + (call.id ?? ''),
            function: {
              name: previous.function.name + (call.function?.name ?? ''),
              arguments:
                previous.function.arguments + (call.function?.arguments ?? ''),
            },
          });
        });
      });
    }

    const calls = [...toolCalls.values()];
    if (
      !calls.length ||
      calls.some(
        (call) =>
          call.function.name !== 'ping' || !call.id || !call.function.arguments,
      )
    ) {
      return {
        success: false,
        error:
          'The model streamed a response but did not call the required tool. Choose a model with OpenAI-compatible tool calling.',
      };
    }
    for (const call of calls) {
      const args: unknown = JSON.parse(call.function.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return {
          success: false,
          error: 'The model returned invalid tool arguments.',
        };
      }
    }
    const continuation = await fetch(
      getLocalProviderBaseUrl(connection.baseUrl, '/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildLocalProviderHeaders(connection),
        },
        body: JSON.stringify({
          model: modelId.replace(`${input.provider}/`, ''),
          stream: true,
          messages: [
            { role: 'user', content: 'Reply with pong.' },
            { role: 'assistant', content: null, tool_calls: calls },
            ...calls.map((call) => ({
              role: 'tool',
              tool_call_id: call.id,
              content: 'pong',
            })),
          ],
        }),
        signal: AbortSignal.timeout(LOCAL_PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!continuation.ok)
      return {
        success: false,
        error: await getQualificationError(input.provider, continuation),
      };
    const events = await readQualificationEvents(continuation);
    const completion = z.object({
      choices: z.array(
        z.object({
          delta: z.object({ content: z.string().nullable().optional() }),
          finish_reason: z.string().nullable().optional(),
        }),
      ),
    });
    const choices = events.flatMap((event) => {
      const parsed = completion.safeParse(event);
      return parsed.success ? parsed.data.choices : [];
    });
    if (
      events.some(
        (event) =>
          typeof event === 'object' && event !== null && 'error' in event,
      ) ||
      !choices.some((choice) => choice.delta.content?.trim()) ||
      !choices.some((choice) => choice.finish_reason === 'stop')
    ) {
      return {
        success: false,
        error:
          'The streamed tool output continuation did not complete with a text response.',
      };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error && !(error instanceof TypeError)
          ? error.message
          : getLocalProviderNetworkError(input.provider),
    };
  }
}
