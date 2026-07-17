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
  ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS,
  getTaskModelProviderId,
  isTaskModelIdDisabled,
} from './task-models';

/**
 * The ChatGPT subscription provider id. It is the only OAuth-backed model
 * provider in the catalog: instead of an API-key env var, an operator
 * connects a ChatGPT Plus/Pro account through OpenAI's device-code flow and
 * Roomote stores the OAuth record. Subscription models keep the `openai/`
 * id prefix (opencode's Codex plugin registers OAuth auth under provider id
 * `openai`), so this id is a configuration/connect surface only — it is not
 * a model-id prefix and is intentionally not in
 * `ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS`.
 */
export const CHATGPT_SUBSCRIPTION_PROVIDER_ID = 'chatgpt' as const;

export const SETUP_MODEL_PROVIDER_IDS = [
  'openrouter',
  ...ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS,
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
] as const;

export type SetupModelProviderId = (typeof SETUP_MODEL_PROVIDER_IDS)[number];

/**
 * How a model provider is authenticated. API-key providers read a single env
 * var (`envVarName`); OAuth providers are connected through a dedicated flow
 * and carry no env var.
 */
export type SetupModelProviderAuthKind = 'api-key' | 'endpoint' | 'oauth';

/**
 * The default-model roles a deployment configures: one model per kind of
 * work. `coding` drives new task launches; every other role falls back to
 * the coding model at runtime when unset.
 */
export type TaskModelRole =
  | 'coding'
  | 'helper'
  | 'vision'
  | 'codeReview'
  | 'explore'
  | 'planning';

/**
 * A provider's recommended default models for the non-coding roles. The
 * coding role's recommendation is always the provider's
 * `defaultRoomoteModel`, so it is intentionally not part of this map; roles
 * left unset are recommended to follow the coding model ("same as coding"
 * at runtime). Every id must be one of the provider's `suggestedTaskModels`
 * so applying recommendations never points a role at a model outside the
 * provider's curated catalog.
 */
export type RecommendedRoleModels = Partial<
  Record<Exclude<TaskModelRole, 'coding'>, string>
>;

export type RecommendedPresetRole = {
  modelId: string;
  displayName?: string;
  family?: string;
  reasoningEffort?: ReasoningEffort;
};

export type RecommendedModelPreset = {
  id: string;
  label: string;
  default?: boolean;
  roles: Partial<Record<TaskModelRole, RecommendedPresetRole>>;
};

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
   * for the provider. Defaults to "API key".
   */
  envVarLabel?: string;
  /** Optional guidance rendered below the primary credential input. */
  credentialHelp?: {
    text: string;
    href: string;
    linkLabel: string;
  };
  /**
   * Additional credential values collected when connecting the provider.
   * Every `required` field must be configured (saved or via runtime env)
   * for the provider to count as connected.
   */
  additionalEnvFields?: readonly SetupModelProviderEnvField[];
  defaultRoomoteModel: string;
  authKind: SetupModelProviderAuthKind;
  suggestedTaskModels: readonly SuggestedTaskModel[];
  /** Models are discovered from the configured endpoint, not a static catalog. */
  dynamicModels?: boolean;
  /**
   * Hides the provider from the setup wizard and settings connect surfaces
   * unless it is already connected (saved or runtime env). The catalog entry
   * stays registered so existing connections keep working: model-id
   * resolution, credential env-var forwarding, and provider labels are
   * unaffected.
   */
  hidden?: boolean;
  /** Provider-local role mappings shown by the settings preset picker. */
  recommendedPresets?: readonly RecommendedModelPreset[];
  /** Legacy single-mapping shape used to synthesize a default preset. */
  recommendedRoleModels?: RecommendedRoleModels;
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
    recommendedPresets: [
      {
        id: 'balanced',
        label: 'Balanced',
        default: true,
        roles: {
          coding: { modelId: DEFAULT_TASK_MODEL_ID, reasoningEffort: 'medium' },
          helper: {
            modelId: 'openrouter/google/gemini-3.5-flash',
            reasoningEffort: 'low',
          },
          codeReview: {
            modelId: 'openrouter/anthropic/claude-opus-4.8',
            reasoningEffort: 'high',
          },
          explore: {
            modelId: 'openrouter/google/gemini-3.5-flash',
            reasoningEffort: 'low',
          },
          planning: {
            modelId: 'openrouter/anthropic/claude-opus-4.8',
            reasoningEffort: 'high',
          },
        },
      },
      {
        id: 'quick-turnaround',
        label: 'Quick turnaround',
        roles: {
          coding: {
            modelId: 'openrouter/google/gemini-3.5-flash',
            reasoningEffort: 'low',
          },
          helper: {
            modelId: 'openrouter/google/gemini-3.5-flash',
            reasoningEffort: 'low',
          },
          codeReview: {
            modelId: 'openrouter/anthropic/claude-opus-4.8',
            reasoningEffort: 'medium',
          },
          explore: {
            modelId: 'openrouter/google/gemini-3.5-flash',
            reasoningEffort: 'low',
          },
          planning: {
            modelId: 'openrouter/anthropic/claude-opus-4.8',
            reasoningEffort: 'medium',
          },
        },
      },
    ],
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
      'kimi-k3': 'vercel/moonshotai/kimi-k3',
      'kimi-k2-7-code': 'vercel/moonshotai/kimi-k2.7-code',
      'qwen3-6-plus': 'vercel/alibaba/qwen3.6-plus',
      'minimax-m3': 'vercel/minimax/minimax-m3',
      'mimo-v2-5': 'vercel/xiaomi/mimo-v2.5',
      'grok-4-5': 'vercel/xai/grok-4.5',
    }),
    // Vision is unset: the recommended coding model is multimodal, so image
    // work follows the coding model ("same as coding").
    recommendedRoleModels: {
      helper: 'vercel/google/gemini-3.5-flash',
      codeReview: 'vercel/anthropic/claude-opus-4.8',
      explore: 'vercel/google/gemini-3.5-flash',
      planning: 'vercel/anthropic/claude-opus-4.8',
    },
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
    // Hidden from new connections for now: the catalog above resolves too
    // few recommended models to seed a useful default list. Existing
    // connections keep working.
    hidden: true,
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
    recommendedRoleModels: {
      helper: 'openai/gpt-5.6-luna',
      codeReview: 'openai/gpt-5.6-sol',
      explore: 'openai/gpt-5.6-luna',
      planning: 'openai/gpt-5.6-sol',
    },
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
    recommendedRoleModels: {
      helper: 'anthropic/claude-haiku-4-5',
      codeReview: 'anthropic/claude-opus-4-8',
      explore: 'anthropic/claude-haiku-4-5',
      planning: 'anthropic/claude-opus-4-8',
    },
  },
  {
    id: 'moonshotai',
    label: 'Moonshot AI (Kimi)',
    envVarName: 'MOONSHOT_API_KEY',
    defaultRoomoteModel: 'moonshotai/kimi-k2.7-code',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'kimi-k3': 'moonshotai/kimi-k3',
      'kimi-k2-7-code': 'moonshotai/kimi-k2.7-code',
    }),
    recommendedRoleModels: {
      vision: 'moonshotai/kimi-k3',
      codeReview: 'moonshotai/kimi-k3',
      planning: 'moonshotai/kimi-k3',
    },
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
    // The default coding model (big-pickle) is OpenCode's own routed model,
    // so vision gets an explicit multimodal recommendation instead of the
    // usual same-as-coding fallback.
    recommendedRoleModels: {
      helper: 'opencode/gemini-3.5-flash',
      vision: 'opencode/claude-sonnet-5',
      codeReview: 'opencode/claude-opus-4-8',
      explore: 'opencode/gemini-3.5-flash',
      planning: 'opencode/claude-opus-4-8',
    },
  },
  {
    // Bedrock's current console issues API keys for the Mantle endpoint. The
    // worker registers this as a custom Anthropic-compatible OpenCode provider
    // so these keys do not fall through to OpenCode's legacy AWS SDK provider.
    id: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    envVarName: 'AWS_BEARER_TOKEN_BEDROCK',
    envVarLabel: 'Mantle API key',
    credentialHelp: {
      text: 'Paste a key generated from the Bedrock Mantle API-key console. Switch the AWS console to the same region you enter below before generating it.',
      href: 'https://us-east-1.console.aws.amazon.com/bedrock-mantle/api-keys',
      linkLabel: 'Open AWS Bedrock API keys',
    },
    additionalEnvFields: [
      {
        envVarName: 'AWS_REGION',
        label: 'AWS region',
        secret: false,
        required: false,
        placeholder: 'us-east-1',
      },
    ],
    defaultRoomoteModel: 'bedrock-mantle/anthropic.claude-sonnet-5',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'bedrock-mantle/anthropic.claude-fable-5',
      'claude-haiku-4-5': 'bedrock-mantle/anthropic.claude-haiku-4-5',
      'claude-opus-4-8': 'bedrock-mantle/anthropic.claude-opus-4-8',
      'claude-sonnet-5': 'bedrock-mantle/anthropic.claude-sonnet-5',
    }),
    recommendedRoleModels: {
      helper: 'bedrock-mantle/anthropic.claude-haiku-4-5',
      codeReview: 'bedrock-mantle/anthropic.claude-opus-4-8',
      explore: 'bedrock-mantle/anthropic.claude-haiku-4-5',
      planning: 'bedrock-mantle/anthropic.claude-opus-4-8',
    },
  },
  {
    // Provider id matches the models.dev/opencode `google` provider (Gemini
    // API / AI Studio keys).
    id: 'google',
    label: 'Google Gemini',
    envVarName: 'GEMINI_API_KEY',
    defaultRoomoteModel: 'google/gemini-3.1-pro-preview',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'gemini-3-1-pro': 'google/gemini-3.1-pro-preview',
      'gemini-3-5-flash': 'google/gemini-3.5-flash',
    }),
    // Pro is the coding default, and code review and planning follow it via
    // "same as coding"; Flash covers the high-volume cheap roles.
    recommendedRoleModels: {
      helper: 'google/gemini-3.5-flash',
      explore: 'google/gemini-3.5-flash',
    },
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
    id: 'litellm',
    label: 'LiteLLM',
    envVarName: 'LITELLM_BASE_URL',
    envVarLabel: 'Endpoint URL',
    additionalEnvFields: [
      {
        envVarName: 'LITELLM_API_KEY',
        label: 'API key',
        secret: true,
        required: true,
      },
    ],
    defaultRoomoteModel: '',
    authKind: 'endpoint',
    suggestedTaskModels: [],
    dynamicModels: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    envVarName: 'OLLAMA_BASE_URL',
    envVarLabel: 'Endpoint URL',
    defaultRoomoteModel: '',
    authKind: 'endpoint',
    suggestedTaskModels: [],
    dynamicModels: true,
  },
  {
    id: 'vllm',
    label: 'vLLM',
    envVarName: 'VLLM_BASE_URL',
    envVarLabel: 'Endpoint URL',
    additionalEnvFields: [
      {
        envVarName: 'VLLM_API_KEY',
        label: 'API key',
        secret: true,
        required: false,
      },
    ],
    defaultRoomoteModel: '',
    authKind: 'endpoint',
    suggestedTaskModels: [],
    dynamicModels: true,
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
    recommendedRoleModels: {
      helper: 'openai/gpt-5.6-luna',
      codeReview: 'openai/gpt-5.6-sol',
      explore: 'openai/gpt-5.6-luna',
      planning: 'openai/gpt-5.6-sol',
    },
  },
] as const satisfies readonly SetupModelProviderDescriptor[];

const EXTRA_MODEL_PROVIDER_ENV_KEYS_BY_PROVIDER = {
  'bedrock-mantle': ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
  gemini: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY'],
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

const MODEL_PROVIDER_NON_SECRET_ENV_VAR_NAMES: ReadonlySet<string> = new Set(
  SETUP_MODEL_PROVIDER_CATALOG.flatMap((provider) =>
    getSetupModelProviderAdditionalEnvFields(provider)
      .filter((field) => !field.secret)
      .map((field) => field.envVarName),
  ),
);

/**
 * Provider credentials that must only enter a task through the selected model
 * runtime resolver. Non-secret provider configuration such as AWS_REGION is
 * excluded so it remains available to unrelated task code.
 */
export const DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES: readonly string[] =
  DEFAULT_MODEL_PROVIDER_ENV_KEYS.filter(
    (name) => !MODEL_PROVIDER_NON_SECRET_ENV_VAR_NAMES.has(name),
  );

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
} as const satisfies Record<TaskModelRole, ReasoningEffort>;

const DEFAULT_RECOMMENDED_PRESET_ID = 'default';

export function getRecommendedModelPresets(
  provider: Pick<
    SetupModelProviderDescriptor,
    'defaultRoomoteModel' | 'recommendedPresets' | 'recommendedRoleModels'
  >,
): readonly RecommendedModelPreset[] {
  if (provider.recommendedPresets?.length) {
    return provider.recommendedPresets;
  }

  const roleModels = provider.recommendedRoleModels ?? {};
  return [
    {
      id: DEFAULT_RECOMMENDED_PRESET_ID,
      label: 'Recommended',
      default: true,
      roles: {
        coding: { modelId: provider.defaultRoomoteModel },
        ...Object.fromEntries(
          Object.entries(roleModels).map(([role, modelId]) => [
            role,
            { modelId },
          ]),
        ),
      },
    },
  ];
}

export function getDefaultRecommendedModelPreset(
  provider: Pick<
    SetupModelProviderDescriptor,
    'defaultRoomoteModel' | 'recommendedPresets' | 'recommendedRoleModels'
  >,
): RecommendedModelPreset {
  const presets = getRecommendedModelPresets(provider);
  return presets.find((preset) => preset.default) ?? presets[0]!;
}

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
  const normalizeEnabledModel = (
    model: string | null | undefined,
  ): string | null => {
    const normalizedModel = normalizeOptionalString(model);

    return normalizedModel && !isTaskModelIdDisabled(normalizedModel)
      ? normalizedModel
      : null;
  };

  return {
    roomoteModel: normalizeEnabledModel(value?.roomoteModel),
    roomoteSmallModel: normalizeEnabledModel(value?.roomoteSmallModel),
    roomoteVisionModel: normalizeEnabledModel(value?.roomoteVisionModel),
    roomoteCodeReviewModel: normalizeEnabledModel(
      value?.roomoteCodeReviewModel,
    ),
    roomoteExploreModel: normalizeEnabledModel(value?.roomoteExploreModel),
    roomotePlanningModel: normalizeEnabledModel(value?.roomotePlanningModel),
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

/**
 * Resolves a provider's recommended default-model configuration: the
 * provider's default model for the coding role plus its recommended
 * non-coding role models, with unset roles left null so they follow the
 * coding model at runtime. Reasoning efforts stay null so the shared
 * per-role defaults (`DEFAULT_MODEL_ROLE_REASONING_EFFORTS`) apply. Used
 * when a provider is connected during setup and by the models settings
 * page's "Use recommended" action.
 */
export function buildRecommendedDeploymentModelConfig(
  provider: Pick<
    SetupModelProviderDescriptor,
    'defaultRoomoteModel' | 'recommendedPresets' | 'recommendedRoleModels'
  >,
  presetId?: string,
): DeploymentModelConfig {
  const presets = getRecommendedModelPresets(provider);
  const preset = presetId
    ? presets.find((candidate) => candidate.id === presetId)
    : getDefaultRecommendedModelPreset(provider);
  const roles = preset?.roles ?? {};

  return normalizeDeploymentModelConfig({
    roomoteModel: roles.coding?.modelId ?? provider.defaultRoomoteModel,
    roomoteSmallModel: roles.helper?.modelId,
    roomoteVisionModel: roles.vision?.modelId,
    roomoteCodeReviewModel: roles.codeReview?.modelId,
    roomoteExploreModel: roles.explore?.modelId,
    roomotePlanningModel: roles.planning?.modelId,
    roomoteModelReasoningEffort: roles.coding?.reasoningEffort,
    roomoteSmallModelReasoningEffort: roles.helper?.reasoningEffort,
    roomoteVisionModelReasoningEffort: roles.vision?.reasoningEffort,
    roomoteCodeReviewModelReasoningEffort: roles.codeReview?.reasoningEffort,
    roomoteExploreModelReasoningEffort: roles.explore?.reasoningEffort,
    roomotePlanningModelReasoningEffort: roles.planning?.reasoningEffort,
  });
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
    (providerId === 'bedrock-mantle'
      ? 'amazon-bedrock'
      : providerId) as SetupModelProviderId,
  );

  if (provider) {
    return provider.label;
  }

  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/**
 * Display/grouping provider for a model id. ChatGPT subscription models retain
 * the runtime `openai/` prefix. When a subscription is the only OpenAI-facing
 * connection, UI lists group those models under ChatGPT. When an OpenAI API
 * key is also present, keep the native OpenAI group so that connected provider
 * remains visible in model settings lists. Callers that only care about which
 * auth path wins at runtime can omit `openaiConnected` so ChatGPT still wins.
 */
export function getDisplayModelProviderId(
  modelId: string | null | undefined,
  options?: {
    chatgptConnected?: boolean;
    openaiConnected?: boolean;
  },
): string | null {
  const normalizedModelId = normalizeOptionalString(modelId);

  if (!normalizedModelId) {
    return null;
  }

  const runtimeProviderId = getTaskModelProviderId(normalizedModelId);

  if (
    runtimeProviderId === 'openai' &&
    options?.chatgptConnected &&
    !options?.openaiConnected
  ) {
    return CHATGPT_SUBSCRIPTION_PROVIDER_ID;
  }

  return runtimeProviderId;
}

export type DisplayModelProviderGroup<T extends { id: string }> = {
  providerId: string;
  label: string;
  items: T[];
};

const KNOWN_MODEL_PROVIDER_ORDER = SETUP_MODEL_PROVIDER_CATALOG.map(
  (provider) => provider.id as string,
);

/**
 * Groups model options by display provider for chooser UIs. Preserves input
 * order within each group and sorts groups by the setup provider catalog.
 */
export function groupModelsByDisplayProvider<T extends { id: string }>(
  items: T[],
  options?: {
    chatgptConnected?: boolean;
    openaiConnected?: boolean;
  },
): DisplayModelProviderGroup<T>[] {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const providerId =
      getDisplayModelProviderId(item.id, {
        chatgptConnected: options?.chatgptConnected,
        openaiConnected: options?.openaiConnected,
      }) ?? 'other';
    const groupItems = groups.get(providerId) ?? [];
    groupItems.push(item);
    groups.set(providerId, groupItems);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => {
      const leftIndex = KNOWN_MODEL_PROVIDER_ORDER.indexOf(left);
      const rightIndex = KNOWN_MODEL_PROVIDER_ORDER.indexOf(right);
      const leftOrder =
        leftIndex === -1 ? KNOWN_MODEL_PROVIDER_ORDER.length : leftIndex;
      const rightOrder =
        rightIndex === -1 ? KNOWN_MODEL_PROVIDER_ORDER.length : rightIndex;

      return leftOrder - rightOrder || left.localeCompare(right);
    })
    .map(([providerId, groupItems]) => ({
      providerId,
      label: getModelProviderLabel(providerId),
      items: groupItems,
    }));
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

  if (providerId === 'bedrock-mantle') {
    return 'amazon-bedrock';
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

/** Legacy Google Vertex credential name, reserved and stripped while the provider is disabled. */
const GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME =
  'GOOGLE_APPLICATION_CREDENTIALS';

/** Legacy direct Mistral credential name, reserved and stripped while support is disabled. */
const MISTRAL_API_KEY_ENV_VAR_NAME = 'MISTRAL_API_KEY';

/** Credentials belonging to providers Roomote currently refuses to run. */
export const DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES = [
  GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME,
  MISTRAL_API_KEY_ENV_VAR_NAME,
] as const;

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
  const runtimeRoomoteModel = normalizeOptionalString(runtimeEnv.R_MODEL);
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

  const providers = SETUP_MODEL_PROVIDER_CATALOG.map(
    (provider): SetupModelProviderStatus => {
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

      // Providers with multiple credential fields (e.g. Bedrock) are satisfied only
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
        [
          ...(provider.authKind === 'endpoint' && provider.envVarName
            ? [
                {
                  envVarName: provider.envVarName,
                  secret: false,
                },
              ]
            : []),
          ...getSetupModelProviderAdditionalEnvFields(provider),
        ]
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
    },
  ).filter(
    // Hidden providers are not offered for new connections but stay listed
    // (and manageable) while they are connected.
    (provider) =>
      !provider.hidden ||
      provider.runtimeApiKeySatisfied ||
      provider.savedApiKeySatisfied,
  );

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
