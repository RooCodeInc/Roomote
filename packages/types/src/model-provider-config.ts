import {
  isReasoningEffort,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
} from './task-runs';
import {
  OPENROUTER_RECOMMENDED_TASK_MODEL_SLUGS,
  mapRecommendedTaskModels,
  type SuggestedTaskModel,
} from './recommended-task-models';
import {
  DEFAULT_TASK_MODEL_ID,
  DIRECT_TASK_MODEL_PROVIDER_IDS,
} from './task-models';

/**
 * The ChatGPT subscription provider id. It is the only OAuth-backed model
 * provider in the catalog: instead of an API-key env var, an operator
 * connects a ChatGPT Plus/Pro account through OpenAI's device-code flow and
 * Roomote stores the OAuth record. Subscription models keep the `openai/`
 * id prefix (opencode's Codex plugin registers OAuth auth under provider id
 * `openai`), so this id is a configuration/connect surface only — it is not
 * a model-id prefix and is intentionally not in
 * `DIRECT_TASK_MODEL_PROVIDER_IDS`.
 */
export const CHATGPT_SUBSCRIPTION_PROVIDER_ID = 'chatgpt' as const;

export const SETUP_MODEL_PROVIDER_IDS = [
  'openrouter',
  ...DIRECT_TASK_MODEL_PROVIDER_IDS,
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
] as const;

export type SetupModelProviderId = (typeof SETUP_MODEL_PROVIDER_IDS)[number];

/**
 * How a model provider is authenticated. API-key providers read a single env
 * var (`envVarName`); OAuth providers are connected through a dedicated flow
 * and carry no env var.
 */
export type SetupModelProviderAuthKind = 'api-key' | 'oauth';

/**
 * An additional credential value a provider needs beyond its primary API-key
 * env var (`envVarName`), such as an AWS region or a GCP project id. The
 * connect UI renders one input per field; `required` fields also participate
 * in the provider's connected/satisfied status.
 */
export type SetupModelProviderEnvField = {
  envVarName: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
};

export type SetupModelProviderDescriptor = {
  id: SetupModelProviderId;
  label: string;
  /**
   * Env var holding the API key (or primary credential). Required for
   * `api-key` providers; omitted for `oauth` providers.
   */
  envVarName?: string;
  /**
   * Human label for the primary credential when "API key" is not accurate
   * (e.g. Vertex takes a service account JSON). Defaults to "API key".
   */
  envVarLabel?: string;
  /**
   * Additional credential values collected when connecting the provider.
   * Every `required` field must be configured (saved or via runtime env)
   * for the provider to count as connected.
   */
  additionalEnvFields?: readonly SetupModelProviderEnvField[];
  defaultRoomoteModel: string;
  authKind: SetupModelProviderAuthKind;
  suggestedTaskModels: readonly SuggestedTaskModel[];
};

export const DEFAULT_SETUP_MODEL_PROVIDER_ID: SetupModelProviderId =
  'openrouter';

export const SETUP_MODEL_PROVIDER_CATALOG = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVarName: 'OPENROUTER_API_KEY',
    defaultRoomoteModel: DEFAULT_TASK_MODEL_ID,
    authKind: 'api-key',
    // OpenRouter routes every lab in the centralized recommended list, and
    // its slug map doubles as the default task model catalog.
    suggestedTaskModels: mapRecommendedTaskModels(
      OPENROUTER_RECOMMENDED_TASK_MODEL_SLUGS,
    ),
  },
  {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    envVarName: 'AI_GATEWAY_API_KEY',
    defaultRoomoteModel: 'vercel/openai/gpt-5.6-terra',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'vercel/anthropic/claude-fable-5',
      'claude-haiku-4-5': 'vercel/anthropic/claude-haiku-4.5',
      'claude-opus-4-8': 'vercel/anthropic/claude-opus-4.8',
      'claude-sonnet-5': 'vercel/anthropic/claude-sonnet-5',
      'gpt-5-6-sol': 'vercel/openai/gpt-5.6-sol',
      'gpt-5-6-terra': 'vercel/openai/gpt-5.6-terra',
      'gpt-5-6-luna': 'vercel/openai/gpt-5.6-luna',
      'gemini-3-1-pro': 'vercel/google/gemini-3.1-pro-preview',
      'gemini-3-5-flash': 'vercel/google/gemini-3.5-flash',
      'deepseek-v4-flash': 'vercel/deepseek/deepseek-v4-flash',
      'deepseek-v4-pro': 'vercel/deepseek/deepseek-v4-pro',
      'glm-5-2': 'vercel/zai/glm-5.2',
      'kimi-k2-7-code': 'vercel/moonshotai/kimi-k2.7-code',
      'qwen3-6-plus': 'vercel/alibaba/qwen3.6-plus',
      'minimax-m3': 'vercel/minimax/minimax-m3',
      'mimo-v2-5': 'vercel/xiaomi/mimo-v2.5',
      'grok-4-5': 'vercel/xai/grok-4.5',
    }),
  },
  {
    id: 'requesty',
    label: 'Requesty',
    envVarName: 'REQUESTY_API_KEY',
    defaultRoomoteModel: 'requesty/anthropic/claude-haiku-4-5',
    authKind: 'api-key',
    // Requesty's models.dev catalog does not yet list GPT 5.6 Sol/Terra/Luna,
    // so only recommended models that resolve there are suggested.
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-haiku-4-5': 'requesty/anthropic/claude-haiku-4-5',
    }),
  },
  {
    id: 'baseten',
    label: 'Baseten',
    envVarName: 'BASETEN_API_KEY',
    defaultRoomoteModel: 'baseten/moonshotai/Kimi-K2.7-Code',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'deepseek-v4-pro': 'baseten/deepseek-ai/DeepSeek-V4-Pro',
      'glm-5-2': 'baseten/zai-org/GLM-5.2',
      'kimi-k2-7-code': 'baseten/moonshotai/Kimi-K2.7-Code',
    }),
  },
  {
    // Provider id matches the models.dev `togetherai` provider so catalog
    // suggestion derivation and gateway pricing lookup resolve against the
    // live Together AI catalog.
    id: 'togetherai',
    label: 'Together AI',
    envVarName: 'TOGETHER_API_KEY',
    defaultRoomoteModel: 'togetherai/deepseek-ai/DeepSeek-V4-Pro',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'deepseek-v4-pro': 'togetherai/deepseek-ai/DeepSeek-V4-Pro',
      'glm-5-2': 'togetherai/zai-org/GLM-5.2',
      'kimi-k2-7-code': 'togetherai/moonshotai/Kimi-K2.7-Code',
      'qwen3-6-plus': 'togetherai/Qwen/Qwen3.6-Plus',
      'minimax-m3': 'togetherai/MiniMaxAI/MiniMax-M3',
    }),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVarName: 'OPENAI_API_KEY',
    defaultRoomoteModel: 'openai/gpt-5.6-terra',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'gpt-5-6-sol': 'openai/gpt-5.6-sol',
      'gpt-5-6-terra': 'openai/gpt-5.6-terra',
      'gpt-5-6-luna': 'openai/gpt-5.6-luna',
    }),
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVarName: 'ANTHROPIC_API_KEY',
    defaultRoomoteModel: 'anthropic/claude-sonnet-5',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'anthropic/claude-fable-5',
      'claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
      'claude-opus-4-8': 'anthropic/claude-opus-4-8',
      'claude-sonnet-5': 'anthropic/claude-sonnet-5',
    }),
  },
  {
    id: 'moonshotai',
    label: 'Moonshot AI (Kimi)',
    envVarName: 'MOONSHOT_API_KEY',
    defaultRoomoteModel: 'moonshotai/kimi-k2.7-code',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'kimi-k2-7-code': 'moonshotai/kimi-k2.7-code',
    }),
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    envVarName: 'MINIMAX_API_KEY',
    defaultRoomoteModel: 'minimax/MiniMax-M3',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'minimax-m3': 'minimax/MiniMax-M3',
    }),
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen / Go',
    envVarName: 'OPENCODE_API_KEY',
    defaultRoomoteModel: 'opencode/big-pickle',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'opencode/claude-fable-5',
      'claude-haiku-4-5': 'opencode/claude-haiku-4-5',
      'claude-opus-4-8': 'opencode/claude-opus-4-8',
      'claude-sonnet-5': 'opencode/claude-sonnet-5',
      'gemini-3-1-pro': 'opencode/gemini-3.1-pro',
      'gemini-3-5-flash': 'opencode/gemini-3.5-flash',
      'deepseek-v4-flash': 'opencode/deepseek-v4-flash',
      'deepseek-v4-pro': 'opencode/deepseek-v4-pro',
      'glm-5-2': 'opencode/glm-5.2',
      'kimi-k2-7-code': 'opencode/kimi-k2.7-code',
      'qwen3-6-plus': 'opencode/qwen3.6-plus',
      'minimax-m3': 'opencode/minimax-m3',
      'grok-4-5': 'opencode/grok-4.5',
    }),
  },
  {
    // Provider id matches the models.dev/opencode `amazon-bedrock` provider
    // so `amazon-bedrock/<model>` slugs resolve at runtime. Auth uses a
    // Bedrock API key (bearer token); operators using ambient AWS access
    // keys can forward them with `ROOMOTE_MODEL_ENV_KEYS` instead.
    id: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    envVarName: 'AWS_BEARER_TOKEN_BEDROCK',
    envVarLabel: 'Bedrock API key',
    additionalEnvFields: [
      {
        envVarName: 'AWS_REGION',
        label: 'AWS region',
        secret: false,
        required: false,
        placeholder: 'us-east-1',
      },
    ],
    defaultRoomoteModel: 'amazon-bedrock/global.anthropic.claude-sonnet-5',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'amazon-bedrock/global.anthropic.claude-fable-5',
      'claude-haiku-4-5':
        'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
      'claude-opus-4-8': 'amazon-bedrock/global.anthropic.claude-opus-4-8',
      'claude-sonnet-5': 'amazon-bedrock/global.anthropic.claude-sonnet-5',
    }),
  },
  {
    // Provider id matches the models.dev/opencode `google-vertex` provider.
    // The primary credential accepts either pasted service-account JSON
    // (materialized to a file before opencode starts) or a file path on the
    // host for env-managed deployments.
    id: 'google-vertex',
    label: 'Google Vertex AI',
    envVarName: 'GOOGLE_APPLICATION_CREDENTIALS',
    envVarLabel: 'Service account JSON',
    additionalEnvFields: [
      {
        envVarName: 'GOOGLE_VERTEX_PROJECT',
        label: 'Project ID',
        secret: false,
        required: true,
        placeholder: 'my-gcp-project',
      },
      {
        envVarName: 'GOOGLE_VERTEX_LOCATION',
        label: 'Location',
        secret: false,
        required: false,
        placeholder: 'us-central1',
      },
    ],
    defaultRoomoteModel: 'google-vertex/gemini-3.5-flash',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-haiku-4-5': 'google-vertex/claude-haiku-4-5@20251001',
      'claude-opus-4-8': 'google-vertex/claude-opus-4-8@default',
      'claude-sonnet-5': 'google-vertex/claude-sonnet-5@default',
      'gemini-3-1-pro': 'google-vertex/gemini-3.1-pro-preview',
      'gemini-3-5-flash': 'google-vertex/gemini-3.5-flash',
    }),
  },
  {
    // Provider id matches the models.dev/opencode `google` provider (Gemini
    // API / AI Studio keys).
    id: 'google',
    label: 'Google Gemini',
    envVarName: 'GEMINI_API_KEY',
    defaultRoomoteModel: 'google/gemini-3.5-flash',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'gemini-3-1-pro': 'google/gemini-3.1-pro-preview',
      'gemini-3-5-flash': 'google/gemini-3.5-flash',
    }),
  },
  {
    // Provider id matches the models.dev/opencode `xai` provider so
    // `xai/<model>` slugs resolve at runtime.
    id: 'xai',
    label: 'xAI',
    envVarName: 'XAI_API_KEY',
    defaultRoomoteModel: 'xai/grok-4.5',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'grok-4-5': 'xai/grok-4.5',
    }),
  },
  {
    id: CHATGPT_SUBSCRIPTION_PROVIDER_ID,
    label: 'ChatGPT (subscription)',
    envVarName: undefined,
    defaultRoomoteModel: 'openai/gpt-5.6-terra',
    authKind: 'oauth',
    suggestedTaskModels: mapRecommendedTaskModels({
      'gpt-5-6-sol': 'openai/gpt-5.6-sol',
      'gpt-5-6-terra': 'openai/gpt-5.6-terra',
      'gpt-5-6-luna': 'openai/gpt-5.6-luna',
    }),
  },
] as const satisfies readonly SetupModelProviderDescriptor[];

const EXTRA_MODEL_PROVIDER_ENV_KEYS_BY_PROVIDER = {
  gemini: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Every env var name a catalog provider reads: the primary credential plus
 * any additional fields. These are what the runtime forwards to the agent
 * harness when a model from the provider is selected.
 */
export function getSetupModelProviderEnvVarNames(
  provider: Pick<
    SetupModelProviderDescriptor,
    'envVarName' | 'additionalEnvFields'
  >,
): string[] {
  return [
    ...(provider.envVarName ? [provider.envVarName] : []),
    ...getSetupModelProviderAdditionalEnvFields(provider).map(
      (field) => field.envVarName,
    ),
  ];
}

export function getSetupModelProviderAdditionalEnvFields(provider: {
  readonly [key: string]: unknown;
  additionalEnvFields?: readonly SetupModelProviderEnvField[];
}): readonly SetupModelProviderEnvField[] {
  return provider.additionalEnvFields ?? [];
}

function getSetupModelProviderRequiredEnvVarNames(
  provider: Pick<
    SetupModelProviderDescriptor,
    'envVarName' | 'additionalEnvFields'
  >,
): string[] {
  return [
    ...(provider.envVarName ? [provider.envVarName] : []),
    ...getSetupModelProviderAdditionalEnvFields(provider)
      .filter((field) => field.required)
      .map((field) => field.envVarName),
  ];
}

const MODEL_PROVIDER_ENV_KEYS_BY_PROVIDER = new Map<string, readonly string[]>(
  [
    ...SETUP_MODEL_PROVIDER_CATALOG.map(
      (provider) =>
        [
          provider.id as string,
          getSetupModelProviderEnvVarNames(provider),
        ] as const,
    ),
    ...Object.entries(EXTRA_MODEL_PROVIDER_ENV_KEYS_BY_PROVIDER),
  ].reduce((byProvider, [providerId, envKeys]) => {
    byProvider.set(providerId, [
      ...new Set([...(byProvider.get(providerId) ?? []), ...envKeys]),
    ]);
    return byProvider;
  }, new Map<string, readonly string[]>()),
);

export const DEFAULT_MODEL_PROVIDER_ENV_KEYS: readonly string[] = [
  ...new Set([...MODEL_PROVIDER_ENV_KEYS_BY_PROVIDER.values()].flat()),
];

export const REASONING_EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
} satisfies Record<ReasoningEffort, string>;

export const REASONING_EFFORT_OPTIONS = REASONING_EFFORT_VALUES.map(
  (value) => ({
    value,
    label: REASONING_EFFORT_LABELS[value],
  }),
);

const SETUP_MODEL_PROVIDER_BY_ID = new Map<
  SetupModelProviderId,
  SetupModelProviderDescriptor
>(SETUP_MODEL_PROVIDER_CATALOG.map((provider) => [provider.id, provider]));

export type DeploymentModelConfig = {
  roomoteModel: string | null;
  roomoteSmallModel: string | null;
  roomoteVisionModel: string | null;
  roomoteCodeReviewModel: string | null;
  roomoteExploreModel: string | null;
  roomotePlanningModel: string | null;
  roomoteModelReasoningEffort: ReasoningEffort | null;
  roomoteSmallModelReasoningEffort: ReasoningEffort | null;
  roomoteVisionModelReasoningEffort: ReasoningEffort | null;
  roomoteCodeReviewModelReasoningEffort: ReasoningEffort | null;
  roomoteExploreModelReasoningEffort: ReasoningEffort | null;
  roomotePlanningModelReasoningEffort: ReasoningEffort | null;
};

/**
 * Roomote's default reasoning level per default-model role. Applied at
 * runtime when no explicit level is persisted or env-configured for the
 * role, and skipped for models whose metadata reports that they do not
 * support configurable reasoning.
 */
export const DEFAULT_MODEL_ROLE_REASONING_EFFORTS = {
  coding: 'medium',
  helper: 'low',
  vision: 'low',
  codeReview: 'high',
  explore: 'low',
  planning: 'high',
} as const satisfies Record<string, ReasoningEffort>;

export type SetupModelProviderStatus = SetupModelProviderDescriptor & {
  runtimeApiKeySatisfied: boolean;
  savedApiKeySatisfied: boolean;
  additionalEnvValues: Record<string, string>;
};

export type SetupModelStatus = {
  runtimeRoomoteModel: string | null;
  runtimeRoomoteModelSatisfied: boolean;
  runtimeProviderId: string | null;
  persistedRoomoteModel: string | null;
  persistedProviderId: SetupModelProviderId | null;
  preselectedProvider: SetupModelProviderId;
  providers: SetupModelProviderStatus[];
  setupSatisfied: boolean;
  setupSatisfiedByRuntimeEnv: boolean;
  /**
   * Whether a ChatGPT subscription is connected for this deployment. The
   * ChatGPT provider shares the `openai/` model-id prefix with the OpenAI
   * API-key provider, so this flag also marks `openai/` role models as
   * usable even when `OPENAI_API_KEY` is not configured.
   */
  chatgptConnected: boolean;
  /**
   * True when both `OPENAI_API_KEY` and a ChatGPT subscription are
   * configured. opencode's Codex plugin prefers OAuth auth when both are
   * present, so the subscription wins at runtime; this flag lets the UI
   * surface a notice so operators are not surprised.
   */
  openaiAndChatGptBothConfigured: boolean;
};

export function createEmptyDeploymentModelConfig(): DeploymentModelConfig {
  return {
    roomoteModel: null,
    roomoteSmallModel: null,
    roomoteVisionModel: null,
    roomoteCodeReviewModel: null,
    roomoteExploreModel: null,
    roomotePlanningModel: null,
    roomoteModelReasoningEffort: null,
    roomoteSmallModelReasoningEffort: null,
    roomoteVisionModelReasoningEffort: null,
    roomoteCodeReviewModelReasoningEffort: null,
    roomoteExploreModelReasoningEffort: null,
    roomotePlanningModelReasoningEffort: null,
  };
}

export function normalizeDeploymentModelConfig(
  value: Partial<DeploymentModelConfig> | null | undefined,
): DeploymentModelConfig {
  return {
    roomoteModel: normalizeOptionalString(value?.roomoteModel),
    roomoteSmallModel: normalizeOptionalString(value?.roomoteSmallModel),
    roomoteVisionModel: normalizeOptionalString(value?.roomoteVisionModel),
    roomoteCodeReviewModel: normalizeOptionalString(
      value?.roomoteCodeReviewModel,
    ),
    roomoteExploreModel: normalizeOptionalString(value?.roomoteExploreModel),
    roomotePlanningModel: normalizeOptionalString(value?.roomotePlanningModel),
    roomoteModelReasoningEffort: normalizeOptionalReasoningEffort(
      value?.roomoteModelReasoningEffort,
    ),
    roomoteSmallModelReasoningEffort: normalizeOptionalReasoningEffort(
      value?.roomoteSmallModelReasoningEffort,
    ),
    roomoteVisionModelReasoningEffort: normalizeOptionalReasoningEffort(
      value?.roomoteVisionModelReasoningEffort,
    ),
    roomoteCodeReviewModelReasoningEffort: normalizeOptionalReasoningEffort(
      value?.roomoteCodeReviewModelReasoningEffort,
    ),
    roomoteExploreModelReasoningEffort: normalizeOptionalReasoningEffort(
      value?.roomoteExploreModelReasoningEffort,
    ),
    roomotePlanningModelReasoningEffort: normalizeOptionalReasoningEffort(
      value?.roomotePlanningModelReasoningEffort,
    ),
  };
}

export function normalizeOptionalReasoningEffort(
  value: unknown,
): ReasoningEffort | null {
  return isReasoningEffort(value) ? value : null;
}

export function getReasoningEffortLabel(value: ReasoningEffort): string {
  return REASONING_EFFORT_LABELS[value];
}

export function getSetupModelProvider(
  providerId: SetupModelProviderId,
): SetupModelProviderDescriptor {
  return (
    SETUP_MODEL_PROVIDER_BY_ID.get(providerId) ??
    SETUP_MODEL_PROVIDER_CATALOG[0]
  );
}

/**
 * Returns a human-readable label for a model provider id. Known providers use
 * their catalog label; unknown prefixes fall back to a capitalized id.
 */
export function getModelProviderLabel(
  providerId: string | null | undefined,
): string {
  if (!providerId) {
    return 'Other';
  }

  const provider = SETUP_MODEL_PROVIDER_BY_ID.get(
    providerId as SetupModelProviderId,
  );

  if (provider) {
    return provider.label;
  }

  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

export function getSetupModelProviderForEnvVarName(
  envVarName: string | null | undefined,
): SetupModelProviderDescriptor | undefined {
  const normalizedName = normalizeOptionalString(envVarName);

  if (!normalizedName) {
    return undefined;
  }

  return SETUP_MODEL_PROVIDER_CATALOG.find(
    (provider) => provider.envVarName === normalizedName,
  );
}

export function resolveSetupModelProviderIdFromModel(
  roomoteModel: string | null | undefined,
): SetupModelProviderId | null {
  const normalizedModel = normalizeOptionalString(roomoteModel);

  if (!normalizedModel) {
    return null;
  }

  const [providerId] = normalizedModel.split('/');

  if (!providerId) {
    return null;
  }

  return SETUP_MODEL_PROVIDER_BY_ID.has(providerId as SetupModelProviderId)
    ? (providerId as SetupModelProviderId)
    : null;
}

export function resolveModelProviderIdFromModel(
  roomoteModel: string | null | undefined,
): string | null {
  const normalizedModel = normalizeOptionalString(roomoteModel);

  if (!normalizedModel) {
    return null;
  }

  const [providerId, modelId] = normalizedModel.split('/');

  if (!providerId || !modelId) {
    return null;
  }

  return providerId;
}

export function parseModelProviderEnvKeys(
  value: string | null | undefined,
): string[] {
  return (
    value
      ?.split(/[,\s]+/u)
      .map((key) => key.trim())
      .filter(Boolean) ?? []
  );
}

export function getModelProviderEnvKeyCandidates(input: {
  providerId: string | null | undefined;
  configuredEnvKeys?: Iterable<string> | string | null | undefined;
}): string[] {
  const normalizedProviderId = normalizeOptionalString(
    input.providerId,
  )?.toLowerCase();
  const configuredEnvKeys =
    typeof input.configuredEnvKeys === 'string'
      ? parseModelProviderEnvKeys(input.configuredEnvKeys)
      : Array.from(input.configuredEnvKeys ?? [])
          .map((key) => normalizeOptionalString(key))
          .filter((key): key is string => key !== null);

  return [
    ...new Set([
      ...(normalizedProviderId
        ? (MODEL_PROVIDER_ENV_KEYS_BY_PROVIDER.get(normalizedProviderId) ?? [])
        : []),
      ...configuredEnvKeys,
    ]),
  ];
}

export function isConfiguredEnvValue(
  value: string | null | undefined,
): value is string {
  return normalizeOptionalString(value) !== null;
}

/**
 * Env var Google's auth library reads as a *file path* to service-account
 * credentials. Roomote also accepts pasted JSON contents in this variable
 * (the Vertex connect UI collects it that way); runtimes that spawn opencode
 * detect inline JSON with `isInlineGoogleCredentialsValue` and materialize
 * it to a file before the auth library reads the variable.
 */
export const GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME =
  'GOOGLE_APPLICATION_CREDENTIALS';

/**
 * Whether a `GOOGLE_APPLICATION_CREDENTIALS` value is inline service-account
 * JSON rather than a file path.
 */
export function isInlineGoogleCredentialsValue(
  value: string | null | undefined,
): value is string {
  return normalizeOptionalString(value)?.startsWith('{') ?? false;
}

/**
 * Validates and collects the env values to persist when connecting an
 * API-key model provider: the primary credential plus any additional fields
 * the provider declares. Rejects values for undeclared env vars, and
 * requires every missing required credential to already be satisfied (saved
 * or provided by the runtime env, per `isEnvVarSatisfied`). Optional
 * additional fields that are explicitly submitted as blank are returned in
 * `clearedEnvVarNames` so callers can delete the previously saved value.
 */
export function collectSetupModelProviderCredentialValues(options: {
  provider: SetupModelProviderDescriptor;
  apiKey?: string | null;
  additionalEnvValues?: Record<string, string> | null;
  isEnvVarSatisfied: (envVarName: string) => boolean;
  /** Verb phrase for error messages, e.g. `save it` or `continue`. */
  action: string;
}): {
  values: Array<{ name: string; value: string }>;
  clearedEnvVarNames: string[];
} {
  const { provider } = options;
  const providerEnvVarName = provider.envVarName;

  if (!providerEnvVarName) {
    throw new Error(
      `${provider.label} provider is missing an API key env var.`,
    );
  }

  const additionalEnvFields = provider.additionalEnvFields ?? [];
  const declaredEnvVarNames = new Set(
    additionalEnvFields.map((field) => field.envVarName),
  );

  for (const name of Object.keys(options.additionalEnvValues ?? {})) {
    if (!declaredEnvVarNames.has(name)) {
      throw new Error(`${provider.label} does not accept a ${name} value.`);
    }
  }

  const nextApiKey = options.apiKey?.trim() ?? '';

  if (!nextApiKey && !options.isEnvVarSatisfied(providerEnvVarName)) {
    throw new Error(
      provider.envVarLabel
        ? `Enter the ${provider.envVarLabel} for ${provider.label} to ${options.action}.`
        : `Enter your ${provider.label} API key to ${options.action}.`,
    );
  }

  const values: Array<{ name: string; value: string }> = nextApiKey
    ? [{ name: providerEnvVarName, value: nextApiKey }]
    : [];
  const clearedEnvVarNames: string[] = [];

  for (const field of additionalEnvFields) {
    const submittedValue = options.additionalEnvValues?.[field.envVarName];
    const value = submittedValue?.trim() ?? '';

    if (value) {
      values.push({ name: field.envVarName, value });
    } else if (field.required) {
      if (!options.isEnvVarSatisfied(field.envVarName)) {
        throw new Error(
          `Enter the ${field.label} for ${provider.label} to ${options.action}.`,
        );
      }
    } else if (submittedValue !== undefined) {
      // The optional field was explicitly submitted as blank: clear any
      // previously saved value instead of silently keeping it.
      clearedEnvVarNames.push(field.envVarName);
    }
  }

  return { values, clearedEnvVarNames };
}

export function buildSetupModelStatus(input: {
  runtimeEnv?: Partial<Record<string, string | undefined>> | null;
  persistedModelConfig?: Partial<DeploymentModelConfig> | null;
  persistedEnvVarNames?: Iterable<string>;
  persistedEnvVarValues?: Partial<Record<string, string>>;
  selectedProvider?: SetupModelProviderId | null;
  /**
   * Whether a ChatGPT subscription is connected for this deployment. Drives
   * satisfaction for the `chatgpt` OAuth provider and for `openai/` role
   * models that can run on the subscription instead of an API key.
   */
  chatgptConnected?: boolean;
}): SetupModelStatus {
  const runtimeEnv = input.runtimeEnv ?? {};
  const chatgptConnected = Boolean(input.chatgptConnected);
  const persistedModelConfig = normalizeDeploymentModelConfig(
    input.persistedModelConfig,
  );
  const runtimeRoomoteModel = normalizeOptionalString(runtimeEnv.ROOMOTE_MODEL);
  const runtimeRoomoteModelSatisfied = runtimeRoomoteModel !== null;
  const runtimeProviderId =
    resolveModelProviderIdFromModel(runtimeRoomoteModel);
  const runtimeKnownProviderId =
    resolveSetupModelProviderIdFromModel(runtimeRoomoteModel);
  const persistedProviderId = resolveSetupModelProviderIdFromModel(
    persistedModelConfig.roomoteModel,
  );
  const persistedEnvVarNameSet = new Set(
    Array.from(input.persistedEnvVarNames ?? []).map((name) => name.trim()),
  );

  const preselectedProvider =
    runtimeKnownProviderId ??
    input.selectedProvider ??
    persistedProviderId ??
    DEFAULT_SETUP_MODEL_PROVIDER_ID;

  const providers = SETUP_MODEL_PROVIDER_CATALOG.map((provider) => {
    if (provider.authKind === 'oauth') {
      // OAuth providers carry no env var. Satisfaction comes from the
      // connection flag passed in by the caller (chatgptConnected).
      return {
        ...provider,
        additionalEnvValues: {},
        runtimeApiKeySatisfied: false,
        savedApiKeySatisfied: chatgptConnected,
      };
    }

    // Multi-credential providers (e.g. Bedrock, Vertex) are satisfied only
    // when every required env var is configured. Runtime satisfaction is
    // runtime-env-only; saved satisfaction allows mixed sources (the
    // effective model runtime env resolves each key runtime-first with a DB
    // fallback) as long as at least one required value is actually saved.
    const requiredEnvVarNames =
      getSetupModelProviderRequiredEnvVarNames(provider);
    const hasRequiredEnvVars = requiredEnvVarNames.length > 0;
    const isRuntimeConfigured = (name: string) =>
      isConfiguredEnvValue(runtimeEnv[name]);
    const isPersisted = (name: string) => persistedEnvVarNameSet.has(name);
    const additionalEnvValues = Object.fromEntries(
      getSetupModelProviderAdditionalEnvFields(provider)
        .filter((field) => !field.secret)
        .map((field) => {
          const runtimeValue = normalizeOptionalString(
            runtimeEnv[field.envVarName],
          );
          const persistedValue = normalizeOptionalString(
            input.persistedEnvVarValues?.[field.envVarName],
          );

          return [field.envVarName, runtimeValue ?? persistedValue];
        })
        .filter((entry): entry is [string, string] => entry[1] !== null),
    );

    return {
      ...provider,
      additionalEnvValues,
      runtimeApiKeySatisfied:
        hasRequiredEnvVars && requiredEnvVarNames.every(isRuntimeConfigured),
      savedApiKeySatisfied:
        hasRequiredEnvVars &&
        requiredEnvVarNames.every(
          (name) => isPersisted(name) || isRuntimeConfigured(name),
        ) &&
        requiredEnvVarNames.some(isPersisted),
    };
  });

  const runtimeProviderStatus = providers.find(
    (provider) => provider.id === runtimeKnownProviderId,
  );
  const persistedProviderStatus = providers.find(
    (provider) => provider.id === persistedProviderId,
  );

  // A ChatGPT subscription covers `openai/` models, so it can satisfy the
  // runtime/persisted provider status for the OpenAI API-key provider even
  // without OPENAI_API_KEY.
  const chatgptCoversOpenAi = chatgptConnected;
  const openaiRuntimeSatisfied =
    runtimeProviderStatus?.id === 'openai'
      ? runtimeProviderStatus.runtimeApiKeySatisfied || chatgptCoversOpenAi
      : (runtimeProviderStatus?.runtimeApiKeySatisfied ?? false);
  const openaiPersistedSatisfied =
    persistedProviderStatus?.id === 'openai'
      ? persistedProviderStatus.savedApiKeySatisfied ||
        persistedProviderStatus.runtimeApiKeySatisfied ||
        chatgptCoversOpenAi
      : (persistedProviderStatus?.savedApiKeySatisfied ??
        persistedProviderStatus?.runtimeApiKeySatisfied ??
        false);

  const setupSatisfiedByRuntimeEnv =
    runtimeRoomoteModelSatisfied && openaiRuntimeSatisfied;
  // The persisted model works with a key from either source: the effective
  // model runtime env resolves keys runtime-first with a DB fallback, so a
  // saved model choice plus a runtime-env key is a complete setup. A
  // ChatGPT subscription also satisfies persisted openai/ models.
  const setupSatisfied =
    setupSatisfiedByRuntimeEnv ||
    Boolean(
      persistedModelConfig.roomoteModel &&
      (openaiPersistedSatisfied ||
        (persistedProviderStatus?.id !== 'openai' &&
          (persistedProviderStatus?.savedApiKeySatisfied ||
            persistedProviderStatus?.runtimeApiKeySatisfied))),
    );

  const openaiProvider = providers.find((provider) => provider.id === 'openai');
  const openaiAndChatGptBothConfigured =
    chatgptConnected &&
    Boolean(
      openaiProvider &&
      (openaiProvider.runtimeApiKeySatisfied ||
        openaiProvider.savedApiKeySatisfied),
    );

  return {
    runtimeRoomoteModel,
    runtimeRoomoteModelSatisfied,
    runtimeProviderId,
    persistedRoomoteModel: persistedModelConfig.roomoteModel,
    persistedProviderId,
    preselectedProvider,
    providers,
    setupSatisfied,
    setupSatisfiedByRuntimeEnv,
    chatgptConnected,
    openaiAndChatGptBothConfigured,
  };
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}
