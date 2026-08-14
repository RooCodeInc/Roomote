import {
  isReasoningEffort,
  REASONING_EFFORT_VALUES,
  TASK_MODEL_OVERRIDE_ROLES,
  type ReasoningEffort,
  type TaskModelOverrideRole,
  type TaskModelRoleOverrides,
} from './task-runs';
import {
  OPENROUTER_RECOMMENDED_TASK_MODEL_SLUGS,
  mapRecommendedTaskModels,
  type SuggestedTaskModel,
} from './recommended-task-models';
import {
  applyImplicitLiteLlmModelPrefix,
  DEFAULT_TASK_MODEL_ID,
  ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS,
  getTaskModelProviderId,
  isTaskModelIdDisabled,
  resolveTaskModelIdAlias,
} from './task-models';
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  buildOpenAiCompatibleProviderInstance,
  getOpenAiCompatibleProviderInstance,
  isOpenAiCompatibleProviderId,
  listOpenAiCompatibleProviderInstancesFromEnvNames,
  type OpenAiCompatibleProviderInstance,
} from './openai-compatible-providers';

/**
 * The ChatGPT subscription provider id. Instead of an API-key env var, an
 * operator connects a ChatGPT Plus/Pro account through OpenAI's device-code flow and
 * Roomote stores the OAuth record. Subscription models keep the `openai/`
 * id prefix (opencode's Codex plugin registers OAuth auth under provider id
 * `openai`), so this id is a configuration/connect surface only — it is not
 * a model-id prefix and is intentionally not in
 * `ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS`.
 */
export const CHATGPT_SUBSCRIPTION_PROVIDER_ID = 'chatgpt' as const;

/**
 * Setup-catalog id for SuperGrok / eligible X Premium+ OAuth. Models keep the
 * `xai/` id prefix (opencode's xAI provider), so this id is a
 * configuration/connect surface only — not a model-id prefix.
 */
export const XAI_SUBSCRIPTION_PROVIDER_ID = 'xai-subscription' as const;

/**
 * Model-id prefix used when composing or looking up task models for a setup
 * catalog provider. Subscription connect surfaces are not prefixes: ChatGPT
 * serves `openai/`, SuperGrok serves `xai/`.
 */
export function getSetupProviderTaskModelPrefix(
  providerId: SetupModelProviderId,
): string {
  if (providerId === CHATGPT_SUBSCRIPTION_PROVIDER_ID) {
    return 'openai';
  }

  if (providerId === XAI_SUBSCRIPTION_PROVIDER_ID) {
    return 'xai';
  }

  return providerId;
}

/** Roomote-specific key name for OpenCode Go, kept separate from Zen. */
export const OPENCODE_GO_API_KEY_ENV_VAR_NAME = 'OPENCODE_GO_API_KEY' as const;

export const SETUP_MODEL_PROVIDER_IDS = [
  'openrouter',
  ...ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS,
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
] as const;

/**
 * Built-in catalog providerids. Named OpenAI-compatible connections use
 * `openai-compatible-<slug>` in addition to this closed set.
 */
export type BuiltinSetupModelProviderId =
  (typeof SETUP_MODEL_PROVIDER_IDS)[number];

/**
 * Provider ids accepted by setup/save surfaces: either a built-in catalog id
 * or a named OpenAI-compatible connection (`openai-compatible-<slug>`).
 */
export type SetupModelProviderId =
  | BuiltinSetupModelProviderId
  | `openai-compatible-${string}`;

/**
 * How a model provider is authenticated. API-key providers read a single env
 * var (`envVarName`); OAuth providers are connected through a dedicated flow.
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

export type RecommendedRoleReasoningEfforts = Partial<
  Record<Exclude<TaskModelRole, 'coding'>, ReasoningEffort>
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
  /** When set, connect UIs render a select; values must match an option. */
  options?: readonly { value: string; label: string }[];
};

/**
 * Region values must stay in step with the `region.baseUrls` keys on the
 * matching inference gateway provider; the gateway has no base URL for a
 * region this list offers. `inference-gateway.test.ts` asserts the pairing.
 */
export const ZAI_REGION_OPTIONS = [
  { value: 'global', label: 'International' },
  { value: 'china', label: 'China' },
] as const;

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
  /**
   * When true, operators can connect more than one instance of this provider
   * type. Only OpenAI-compatible supports this today (named instances with
   * distinct env vars and model-id prefixes).
   */
  allowMultipleConnections?: boolean;
  /** Provider-local role mappings shown by the settings preset picker. */
  recommendedPresets?: readonly RecommendedModelPreset[];
  /** Legacy single-mapping shape used to synthesize a default preset. */
  recommendedRoleModels?: RecommendedRoleModels;
  /** Optional reasoning levels for roles in the legacy single mapping. */
  recommendedRoleReasoningEfforts?: RecommendedRoleReasoningEfforts;
};

export const DEFAULT_SETUP_MODEL_PROVIDER_ID: SetupModelProviderId =
  'openrouter';

const OPENAI_RECOMMENDED_MODEL_PRESETS = [
  {
    id: 'default',
    label: 'Recommended',
    default: true,
    roles: {
      coding: {
        modelId: 'openai/gpt-5.6-sol',
        reasoningEffort: 'medium',
      },
      helper: {
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'low',
      },
      vision: {
        modelId: 'openai/gpt-5.6-sol',
        reasoningEffort: 'low',
      },
      codeReview: {
        modelId: 'openai/gpt-5.6-terra',
        reasoningEffort: 'high',
      },
      explore: {
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'low',
      },
      planning: {
        modelId: 'openai/gpt-5.6-sol',
        reasoningEffort: 'xhigh',
      },
    },
  },
  {
    id: 'luna-max',
    label: 'Luna Max',
    roles: {
      coding: {
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'max',
      },
      helper: {
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'low',
      },
      vision: {
        modelId: 'openai/gpt-5.6-sol',
        reasoningEffort: 'low',
      },
      codeReview: {
        modelId: 'openai/gpt-5.6-terra',
        reasoningEffort: 'high',
      },
      explore: {
        modelId: 'openai/gpt-5.6-luna',
        reasoningEffort: 'low',
      },
      planning: {
        modelId: 'openai/gpt-5.6-sol',
        reasoningEffort: 'xhigh',
      },
    },
  },
] as const satisfies readonly RecommendedModelPreset[];

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
            modelId: 'openrouter/google/gemini-3.7-flash',
            reasoningEffort: 'low',
          },
          codeReview: {
            modelId: 'openrouter/anthropic/claude-sonnet-5',
            reasoningEffort: 'medium',
          },
          explore: {
            modelId: 'openrouter/google/gemini-3.7-flash',
            reasoningEffort: 'low',
          },
          planning: {
            modelId: 'openrouter/anthropic/claude-opus-5',
            reasoningEffort: 'high',
          },
        },
      },
      {
        id: 'quick-turnaround',
        label: 'Quick turnaround',
        roles: {
          coding: {
            modelId: 'openrouter/google/gemini-3.7-flash',
            reasoningEffort: 'low',
          },
          helper: {
            modelId: 'openrouter/google/gemini-3.7-flash',
            reasoningEffort: 'low',
          },
          codeReview: {
            modelId: 'openrouter/anthropic/claude-sonnet-5',
            reasoningEffort: 'medium',
          },
          explore: {
            modelId: 'openrouter/google/gemini-3.7-flash',
            reasoningEffort: 'low',
          },
          planning: {
            modelId: 'openrouter/anthropic/claude-opus-5',
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
      'claude-opus-5': 'vercel/anthropic/claude-opus-5',
      'claude-sonnet-5': 'vercel/anthropic/claude-sonnet-5',
      'gpt-5-6-sol': 'vercel/openai/gpt-5.6-sol',
      'gpt-5-6-terra': 'vercel/openai/gpt-5.6-terra',
      'gpt-5-6-luna': 'vercel/openai/gpt-5.6-luna',
      'gemini-3-7-flash': 'vercel/google/gemini-3.7-flash',
      'deepseek-v4-flash-0731': 'vercel/deepseek/deepseek-v4-flash-0731',
      'deepseek-v4-pro-0813': 'vercel/deepseek/deepseek-v4-pro-0813',
      'glm-5-2': 'vercel/zai/glm-5.2',
      'kimi-k3': 'vercel/moonshotai/kimi-k3',
      'kimi-k2-7-code': 'vercel/moonshotai/kimi-k2.7-code',
      'qwen3-8-max': 'vercel/alibaba/qwen3.8-max',
      'minimax-m3': 'vercel/minimax/minimax-m3',
      'grok-4-6': 'vercel/xai/grok-4.6',
    }),
    // Vision is unset: the recommended coding model is multimodal, so image
    // work follows the coding model ("same as coding").
    recommendedRoleModels: {
      helper: 'vercel/google/gemini-3.7-flash',
      codeReview: 'vercel/anthropic/claude-sonnet-5',
      explore: 'vercel/google/gemini-3.7-flash',
      planning: 'vercel/anthropic/claude-opus-5',
    },
    recommendedRoleReasoningEfforts: { codeReview: 'medium' },
  },
  {
    id: 'requesty',
    label: 'Requesty',
    envVarName: 'REQUESTY_API_KEY',
    defaultRoomoteModel: 'requesty/claude-sonnet-5',
    authKind: 'api-key',
    // Requesty's models.dev slugs are provider-local rather than lab/model.
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'requesty/claude-fable-5',
      'claude-haiku-4-5': 'requesty/claude-haiku-4-5',
      'claude-opus-5': 'requesty/claude-opus-5',
      'claude-sonnet-5': 'requesty/claude-sonnet-5',
      'gpt-5-6-sol': 'requesty/gpt-5.6-sol@eu',
      'gpt-5-6-terra': 'requesty/gpt-5.6-terra@eu',
      'gpt-5-6-luna': 'requesty/gpt-5.6-luna@eu',
      'gemini-3-7-flash': 'requesty/gemini-3.7-flash',
      'deepseek-v4-flash-0731': 'requesty/deepseek-v4-flash-0731',
      'glm-5-2': 'requesty/glm-5.2',
      'kimi-k3': 'requesty/kimi-k3',
      'grok-4-6': 'requesty/grok-4.6',
    }),
    recommendedRoleModels: {
      helper: 'requesty/gemini-3.7-flash',
      codeReview: 'requesty/claude-sonnet-5',
      explore: 'requesty/gemini-3.7-flash',
      planning: 'requesty/claude-opus-5',
    },
    recommendedRoleReasoningEfforts: { codeReview: 'medium' },
  },
  {
    id: 'baseten',
    label: 'Baseten',
    envVarName: 'BASETEN_API_KEY',
    defaultRoomoteModel: 'baseten/moonshotai/Kimi-K2.7-Code',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'deepseek-v4-flash-0731': 'baseten/deepseek-ai/DeepSeek-V4-Flash-0731',
      'deepseek-v4-pro-0813': 'baseten/deepseek-ai/DeepSeek-V4-Pro',
      'glm-5-2': 'baseten/zai-org/GLM-5.2',
      'kimi-k3': 'baseten/moonshotai/Kimi-K3',
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
      'deepseek-v4-pro-0813': 'togetherai/deepseek-ai/DeepSeek-V4-Pro',
      'glm-5-2': 'togetherai/zai-org/GLM-5.2',
      'kimi-k3': 'togetherai/moonshotai/Kimi-K3',
      'kimi-k2-7-code': 'togetherai/moonshotai/Kimi-K2.7-Code',
      'minimax-m3': 'togetherai/MiniMaxAI/MiniMax-M3',
    }),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVarName: 'OPENAI_API_KEY',
    defaultRoomoteModel: 'openai/gpt-5.6-sol',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'gpt-5-6-sol': 'openai/gpt-5.6-sol',
      'gpt-5-6-terra': 'openai/gpt-5.6-terra',
      'gpt-5-6-luna': 'openai/gpt-5.6-luna',
    }),
    recommendedPresets: OPENAI_RECOMMENDED_MODEL_PRESETS,
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    envVarName: 'AZURE_API_KEY',
    defaultRoomoteModel: 'azure/gpt-5.6-terra',
    authKind: 'api-key',
    credentialHelp: {
      text: 'Create an Azure OpenAI resource and deploy each model with a deployment name that exactly matches its model ID, such as gpt-5.6-terra.',
      href: 'https://portal.azure.com/',
      linkLabel: 'Open Azure portal',
    },
    additionalEnvFields: [
      {
        envVarName: 'AZURE_RESOURCE_NAME',
        label: 'Resource name',
        secret: false,
        required: true,
        placeholder: 'my-resource',
      },
    ],
    suggestedTaskModels: mapRecommendedTaskModels({
      'gpt-5-6-sol': 'azure/gpt-5.6-sol',
      'gpt-5-6-terra': 'azure/gpt-5.6-terra',
      'gpt-5-6-luna': 'azure/gpt-5.6-luna',
    }),
    recommendedRoleModels: {
      helper: 'azure/gpt-5.6-luna',
      codeReview: 'azure/gpt-5.6-sol',
      explore: 'azure/gpt-5.6-luna',
      planning: 'azure/gpt-5.6-sol',
    },
  },
  {
    id: 'azure-cognitive-services',
    label: 'Azure AI Foundry',
    envVarName: 'AZURE_COGNITIVE_SERVICES_API_KEY',
    defaultRoomoteModel: 'azure-cognitive-services/gpt-5.6-terra',
    authKind: 'api-key',
    credentialHelp: {
      text: 'Create an Azure AI Foundry resource and deploy each model with a deployment name that exactly matches its model ID, such as gpt-5.6-terra.',
      href: 'https://portal.azure.com/',
      linkLabel: 'Open Azure portal',
    },
    additionalEnvFields: [
      {
        envVarName: 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME',
        label: 'Resource name',
        secret: false,
        required: true,
        placeholder: 'my-resource',
      },
    ],
    suggestedTaskModels: mapRecommendedTaskModels({
      'gpt-5-6-sol': 'azure-cognitive-services/gpt-5.6-sol',
      'gpt-5-6-terra': 'azure-cognitive-services/gpt-5.6-terra',
      'gpt-5-6-luna': 'azure-cognitive-services/gpt-5.6-luna',
    }),
    recommendedRoleModels: {
      helper: 'azure-cognitive-services/gpt-5.6-luna',
      codeReview: 'azure-cognitive-services/gpt-5.6-sol',
      explore: 'azure-cognitive-services/gpt-5.6-luna',
      planning: 'azure-cognitive-services/gpt-5.6-sol',
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
      'claude-opus-5': 'anthropic/claude-opus-5',
      'claude-sonnet-5': 'anthropic/claude-sonnet-5',
    }),
    recommendedRoleModels: {
      helper: 'anthropic/claude-haiku-4-5',
      codeReview: 'anthropic/claude-sonnet-5',
      explore: 'anthropic/claude-haiku-4-5',
      planning: 'anthropic/claude-opus-5',
    },
    recommendedRoleReasoningEfforts: { codeReview: 'medium' },
  },
  {
    id: 'moonshotai',
    label: 'Moonshot AI (Kimi)',
    envVarName: 'MOONSHOT_API_KEY',
    defaultRoomoteModel: 'moonshotai/kimi-k2.7-code',
    authKind: 'api-key',
    credentialHelp: {
      text: 'Paste an Open Platform key from platform.kimi.ai. Kimi for Coding membership keys will not work here — use Kimi for Coding instead.',
      href: 'https://platform.kimi.ai/console/api-keys',
      linkLabel: 'Open Kimi API Platform keys',
    },
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
    // Kimi for Coding membership keys authenticate against the Anthropic-compatible
    // coding endpoint, not Open Platform / moonshotai.
    id: 'kimi-for-coding',
    label: 'Kimi for Coding',
    envVarName: 'KIMI_API_KEY',
    envVarLabel: 'Kimi for Coding API key',
    defaultRoomoteModel: 'kimi-for-coding/k3',
    authKind: 'api-key',
    credentialHelp: {
      text: 'Create a key in the Kimi Code console after activating membership. Do not use a platform.kimi.ai / Moonshot Open Platform key here.',
      href: 'https://www.kimi.com/code/console',
      linkLabel: 'Open Kimi Code console',
    },
    suggestedTaskModels: mapRecommendedTaskModels({
      'kimi-k3': 'kimi-for-coding/k3',
      'kimi-k2-7-code': 'kimi-for-coding/k2p7',
    }),
    recommendedRoleModels: {
      helper: 'kimi-for-coding/k2p7',
      vision: 'kimi-for-coding/k3',
      codeReview: 'kimi-for-coding/k3',
      explore: 'kimi-for-coding/k2p7',
      planning: 'kimi-for-coding/k3',
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
    label: 'OpenCode Zen',
    envVarName: 'OPENCODE_API_KEY',
    defaultRoomoteModel: 'opencode/big-pickle',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'opencode/claude-fable-5',
      'claude-haiku-4-5': 'opencode/claude-haiku-4-5',
      'claude-opus-5': 'opencode/claude-opus-5',
      'claude-sonnet-5': 'opencode/claude-sonnet-5',
      'gpt-5-6-sol': 'opencode/gpt-5.6-sol',
      'gpt-5-6-terra': 'opencode/gpt-5.6-terra',
      'gpt-5-6-luna': 'opencode/gpt-5.6-luna',
      'gemini-3-7-flash': 'opencode/gemini-3.7-flash',
      // Zen serves the dated Flash release under this stable model alias.
      'deepseek-v4-flash-0731': 'opencode/deepseek-v4-flash',
      'deepseek-v4-pro-0813': 'opencode/deepseek-v4-pro',
      'glm-5-2': 'opencode/glm-5.2',
      'kimi-k3': 'opencode/kimi-k3',
      'kimi-k2-7-code': 'opencode/kimi-k2.7-code',
      'minimax-m3': 'opencode/minimax-m3',
      'grok-4-6': 'opencode/grok-4.6',
    }),
    // The default coding model (big-pickle) is OpenCode's own routed model,
    // so vision gets an explicit multimodal recommendation instead of the
    // usual same-as-coding fallback.
    recommendedRoleModels: {
      helper: 'opencode/gemini-3.7-flash',
      vision: 'opencode/claude-sonnet-5',
      codeReview: 'opencode/claude-sonnet-5',
      explore: 'opencode/gemini-3.7-flash',
      planning: 'opencode/claude-opus-5',
    },
    recommendedRoleReasoningEfforts: { codeReview: 'medium' },
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    envVarName: OPENCODE_GO_API_KEY_ENV_VAR_NAME,
    credentialHelp: {
      text: 'Subscribe to OpenCode Go and copy the API key from your OpenCode account.',
      href: 'https://opencode.ai/auth',
      linkLabel: 'Open OpenCode account',
    },
    defaultRoomoteModel: 'opencode-go/glm-5.2',
    authKind: 'api-key',
    // Go serves a broader catalog; only models in Roomote's central curated
    // recommendation list are suggested here.
    suggestedTaskModels: mapRecommendedTaskModels({
      'deepseek-v4-flash-0731': 'opencode-go/deepseek-v4-flash',
      'deepseek-v4-pro-0813': 'opencode-go/deepseek-v4-pro',
      'glm-5-2': 'opencode-go/glm-5.2',
      'gpt-5-6-luna': 'opencode-go/gpt-5.6-luna',
      'grok-4-6': 'opencode-go/grok-4.6',
      'kimi-k2-7-code': 'opencode-go/kimi-k2.7-code',
      'kimi-k3': 'opencode-go/kimi-k3',
      'minimax-m3': 'opencode-go/minimax-m3',
      'qwen3-8-max': 'opencode-go/qwen3.8-max',
    }),
    recommendedRoleModels: {
      helper: 'opencode-go/gpt-5.6-luna',
      vision: 'opencode-go/gpt-5.6-luna',
      codeReview: 'opencode-go/minimax-m3',
      explore: 'opencode-go/deepseek-v4-flash',
      planning: 'opencode-go/qwen3.8-max',
    },
  },
  {
    // Bedrock's current console issues API keys for the Mantle endpoint. The
    // worker registers this as a custom Anthropic-compatible OpenCode provider
    // so these keys do not fall through to OpenCode's legacy AWS SDK provider.
    id: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    envVarName: 'AWS_BEARER_TOKEN_BEDROCK',
    envVarLabel: 'API key',
    credentialHelp: {
      text: 'Paste a key generated from the Bedrock API-key console. The same regional key serves native Bedrock and Mantle models.',
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
      'claude-opus-5': 'bedrock-mantle/anthropic.claude-opus-5',
      'claude-sonnet-5': 'bedrock-mantle/anthropic.claude-sonnet-5',
      'gpt-5-6-sol': 'bedrock-mantle/openai.gpt-5.6-sol',
      'gpt-5-6-terra': 'bedrock-mantle/openai.gpt-5.6-terra',
      'gpt-5-6-luna': 'bedrock-mantle/openai.gpt-5.6-luna',
    }),
    recommendedRoleModels: {
      helper: 'bedrock-mantle/anthropic.claude-haiku-4-5',
      codeReview: 'bedrock-mantle/anthropic.claude-sonnet-5',
      explore: 'bedrock-mantle/anthropic.claude-haiku-4-5',
      planning: 'bedrock-mantle/anthropic.claude-opus-5',
    },
    recommendedRoleReasoningEfforts: { codeReview: 'medium' },
  },
  {
    // Provider id matches the models.dev/opencode `google` provider (Gemini
    // API / AI Studio keys).
    id: 'google',
    label: 'Google Gemini',
    envVarName: 'GEMINI_API_KEY',
    defaultRoomoteModel: 'google/gemini-3.7-flash',
    authKind: 'api-key',
    suggestedTaskModels: mapRecommendedTaskModels({
      'gemini-3-7-flash': 'google/gemini-3.7-flash',
    }),
    // All non-coding roles follow the Flash coding default.
  },
  {
    // Provider id matches the models.dev/opencode `xai` provider so
    // `xai/<model>` slugs resolve at runtime. API-key path only; SuperGrok
    // OAuth is a separate catalog entry (`xai-subscription`).
    id: 'xai',
    label: 'xAI',
    envVarName: 'XAI_API_KEY',
    defaultRoomoteModel: 'xai/grok-4.6',
    authKind: 'api-key',
    credentialHelp: {
      text: 'Paste an xAI API key from the console.',
      href: 'https://console.x.ai',
      linkLabel: 'xAI console',
    },
    suggestedTaskModels: mapRecommendedTaskModels({
      'grok-4-6': 'xai/grok-4.6',
    }),
  },
  {
    id: 'zai',
    label: 'Z.AI',
    envVarName: 'ZAI_API_KEY',
    defaultRoomoteModel: 'zai/glm-5.2',
    authKind: 'api-key',
    credentialHelp: {
      text: 'Paste a platform API key for the selected region. International keys come from the Z.AI API console; China keys come from the Zhipu / BigModel console. Coding Plan membership keys belong on Z.AI Coding Plan, not here.',
      href: 'https://z.ai/manage-apikey/apikey-list',
      linkLabel: 'Open Z.AI API keys',
    },
    additionalEnvFields: [
      {
        envVarName: 'ZAI_REGION',
        label: 'Region',
        secret: false,
        required: true,
        options: ZAI_REGION_OPTIONS,
      },
    ],
    suggestedTaskModels: mapRecommendedTaskModels({
      'glm-5-2': 'zai/glm-5.2',
    }),
    recommendedRoleModels: {
      vision: 'zai/glm-5v-turbo',
    },
  },
  {
    id: 'zai-coding-plan',
    label: 'Z.AI Coding Plan',
    envVarName: 'ZAI_CODING_PLAN_API_KEY',
    envVarLabel: 'Z.AI Coding Plan API key',
    defaultRoomoteModel: 'zai-coding-plan/glm-5.2',
    authKind: 'api-key',
    credentialHelp: {
      text: 'Paste a Coding Plan API key for the selected region. Do not use a general platform API key here.',
      href: 'https://docs.z.ai/devpack/overview',
      linkLabel: 'Open Z.AI Coding Plan docs',
    },
    additionalEnvFields: [
      {
        envVarName: 'ZAI_CODING_PLAN_REGION',
        label: 'Region',
        secret: false,
        required: true,
        options: ZAI_REGION_OPTIONS,
      },
    ],
    suggestedTaskModels: mapRecommendedTaskModels({
      'glm-5-2': 'zai-coding-plan/glm-5.2',
    }),
    recommendedRoleModels: {
      vision: 'zai-coding-plan/glm-5v-turbo',
    },
  },
  {
    // Provider id matches models.dev / OpenCode (`github-copilot`).
    // Connections use OpenCode's GitHub device-code OAuth flow.
    id: 'github-copilot',
    label: 'GitHub Copilot',
    envVarName: undefined,
    credentialHelp: {
      text: 'Connect a GitHub account with an active Copilot plan.',
      href: 'https://docs.github.com/en/copilot',
      linkLabel: 'GitHub Copilot docs',
    },
    defaultRoomoteModel: 'github-copilot/gpt-5.6-luna',
    authKind: 'oauth',
    suggestedTaskModels: mapRecommendedTaskModels({
      'claude-fable-5': 'github-copilot/claude-fable-5',
      'claude-haiku-4-5': 'github-copilot/claude-haiku-4.5',
      'claude-opus-5': 'github-copilot/claude-opus-5',
      'claude-sonnet-5': 'github-copilot/claude-sonnet-5',
      'gpt-5-6-sol': 'github-copilot/gpt-5.6-sol',
      'gpt-5-6-terra': 'github-copilot/gpt-5.6-terra',
      'gpt-5-6-luna': 'github-copilot/gpt-5.6-luna',
      'kimi-k3': 'github-copilot/kimi-k3',
      'kimi-k2-7-code': 'github-copilot/kimi-k2.7-code',
    }),
    recommendedPresets: [
      {
        id: 'default',
        label: 'Recommended',
        default: true,
        roles: {
          coding: {
            modelId: 'github-copilot/gpt-5.6-luna',
            reasoningEffort: 'medium',
          },
        },
      },
    ],
  },
  {
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    label: 'OpenAI-compatible',
    envVarName: 'OPENAI_COMPATIBLE_BASE_URL',
    envVarLabel: 'Endpoint URL',
    additionalEnvFields: [
      {
        envVarName: 'OPENAI_COMPATIBLE_API_KEY',
        label: 'API key',
        secret: true,
        required: false,
      },
    ],
    defaultRoomoteModel: '',
    authKind: 'endpoint',
    suggestedTaskModels: [],
    dynamicModels: true,
    allowMultipleConnections: true,
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
    defaultRoomoteModel: 'openai/gpt-5.6-sol',
    authKind: 'oauth',
    suggestedTaskModels: mapRecommendedTaskModels({
      'gpt-5-6-sol': 'openai/gpt-5.6-sol',
      'gpt-5-6-terra': 'openai/gpt-5.6-terra',
      'gpt-5-6-luna': 'openai/gpt-5.6-luna',
    }),
    recommendedPresets: OPENAI_RECOMMENDED_MODEL_PRESETS,
  },
  {
    id: XAI_SUBSCRIPTION_PROVIDER_ID,
    label: 'xAI (Grok subscription)',
    envVarName: undefined,
    defaultRoomoteModel: 'xai/grok-4.6',
    authKind: 'oauth',
    suggestedTaskModels: mapRecommendedTaskModels({
      'grok-4-6': 'xai/grok-4.6',
    }),
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

/**
 * Fills in the default for every selectable field that has no value yet. A
 * select always shows one of its options, so connect UIs must submit that
 * option rather than an empty string; existing values are left untouched.
 */
export function getDefaultAdditionalEnvValues(
  fields: readonly SetupModelProviderEnvField[],
  values: Record<string, string> = {},
): Record<string, string> {
  const seeded = { ...values };

  for (const field of fields) {
    if (
      field.options &&
      field.options.length > 0 &&
      !seeded[field.envVarName]?.trim()
    ) {
      seeded[field.envVarName] = field.options[0]!.value;
    }
  }

  return seeded;
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
  max: 'Max',
} satisfies Record<ReasoningEffort, string>;

export const REASONING_EFFORT_OPTIONS = REASONING_EFFORT_VALUES.map(
  (value) => ({
    value,
    label: REASONING_EFFORT_LABELS[value],
  }),
);

const SETUP_MODEL_PROVIDER_BY_ID = new Map<
  BuiltinSetupModelProviderId,
  SetupModelProviderDescriptor
>(
  SETUP_MODEL_PROVIDER_CATALOG.map((provider) => [
    provider.id as BuiltinSetupModelProviderId,
    provider,
  ]),
);

function buildOpenAiCompatibleSetupDescriptor(
  instance: OpenAiCompatibleProviderInstance,
): SetupModelProviderDescriptor {
  const base = SETUP_MODEL_PROVIDER_BY_ID.get(OPENAI_COMPATIBLE_PROVIDER_ID)!;

  return {
    ...base,
    id: instance.id as SetupModelProviderId,
    label: instance.label,
    envVarName: instance.baseUrlEnvVarName,
    additionalEnvFields: [
      {
        envVarName: instance.apiKeyEnvVarName,
        label: 'API key',
        secret: true,
        required: false,
      },
      ...(instance.labelEnvVarName
        ? [
            {
              envVarName: instance.labelEnvVarName,
              label: 'Connection name',
              secret: false,
              required: false,
            } satisfies SetupModelProviderEnvField,
          ]
        : []),
    ],
  };
}

/**
 * True when `value` is a built-in setup provider id or a named
 * OpenAI-compatible connection id (`openai-compatible-<slug>`).
 */
export function isSetupModelProviderId(
  value: string,
): value is SetupModelProviderId {
  if (SETUP_MODEL_PROVIDER_BY_ID.has(value as BuiltinSetupModelProviderId)) {
    return true;
  }

  return isOpenAiCompatibleProviderId(value);
}

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

/**
 * Runtime env var names carrying each overridable non-coding role's model and
 * reasoning level into the sandbox. Must stay in sync with the env bag
 * emitted by `resolveModelRuntimeEnv` in packages/db and consumed by the
 * worker's OpenCode config generation.
 */
export const TASK_MODEL_OVERRIDE_ROLE_ENV_VARS = {
  helper: {
    model: 'R_SMALL_MODEL',
    reasoningEffort: 'R_SMALL_MODEL_REASONING_EFFORT',
  },
  vision: {
    model: 'R_VISION_MODEL',
    reasoningEffort: 'R_VISION_MODEL_REASONING_EFFORT',
  },
  codeReview: {
    model: 'R_CODE_REVIEW_MODEL',
    reasoningEffort: 'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
  },
  explore: {
    model: 'R_EXPLORE_MODEL',
    reasoningEffort: 'R_EXPLORE_MODEL_REASONING_EFFORT',
  },
  planning: {
    model: 'R_PLANNING_MODEL',
    reasoningEffort: 'R_PLANNING_MODEL_REASONING_EFFORT',
  },
} as const satisfies Record<
  TaskModelOverrideRole,
  { model: string; reasoningEffort: string }
>;

/**
 * Materializes a task's per-role overrides into the runtime env var overlay
 * the worker applies on top of the deployment role env vars at harness spawn.
 */
export function buildTaskModelRoleOverrideEnv(
  overrides: TaskModelRoleOverrides | null | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (!overrides) {
    return env;
  }

  for (const role of TASK_MODEL_OVERRIDE_ROLES) {
    const override = overrides[role];

    if (!override) {
      continue;
    }

    const envVarNames = TASK_MODEL_OVERRIDE_ROLE_ENV_VARS[role];

    if (override.model?.trim()) {
      env[envVarNames.model] = override.model.trim();
    }

    if (override.reasoningEffort) {
      env[envVarNames.reasoningEffort] = override.reasoningEffort;
    }
  }

  return env;
}

const DEFAULT_RECOMMENDED_PRESET_ID = 'default';

export function getRecommendedModelPresets(
  provider: Pick<
    SetupModelProviderDescriptor,
    | 'defaultRoomoteModel'
    | 'recommendedPresets'
    | 'recommendedRoleModels'
    | 'recommendedRoleReasoningEfforts'
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
          Object.entries(roleModels).map(([role, modelId]) => {
            const reasoningEffort =
              provider.recommendedRoleReasoningEfforts?.[
                role as keyof RecommendedRoleReasoningEfforts
              ];

            return [
              role,
              {
                modelId,
                ...(reasoningEffort ? { reasoningEffort } : {}),
              },
            ];
          }),
        ),
      },
    },
  ];
}

export function getDefaultRecommendedModelPreset(
  provider: Pick<
    SetupModelProviderDescriptor,
    | 'defaultRoomoteModel'
    | 'recommendedPresets'
    | 'recommendedRoleModels'
    | 'recommendedRoleReasoningEfforts'
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
  /** Whether a GitHub Copilot subscription OAuth record is connected. */
  githubCopilotConnected?: boolean;
  /**
   * Whether an xAI Grok subscription OAuth record is connected. The `xai`
   * catalog entry still accepts `XAI_API_KEY`; this flag marks the provider
   * connected when only the subscription is present (and lets the gateway
   * prefer the OAuth bearer when both exist).
   */
  xaiSubscriptionConnected?: boolean;
  /**
   * Whether an `XAI_API_KEY` is configured (runtime or saved), independent of
   * the SuperGrok subscription. Used by Settings to show both paths without
   * double-counting an OAuth-only connection as an API-key row.
   */
  xaiApiKeyConnected?: boolean;
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
    const trimmedModel = normalizeOptionalString(model);
    const normalizedModel = trimmedModel
      ? resolveTaskModelIdAlias(trimmedModel)
      : null;

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
    | 'defaultRoomoteModel'
    | 'recommendedPresets'
    | 'recommendedRoleModels'
    | 'recommendedRoleReasoningEfforts'
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
  providerId: SetupModelProviderId | string,
): SetupModelProviderDescriptor {
  const builtin = SETUP_MODEL_PROVIDER_BY_ID.get(
    providerId as BuiltinSetupModelProviderId,
  );

  if (builtin) {
    return builtin;
  }

  const openAiCompatible = getOpenAiCompatibleProviderInstance(providerId);
  if (openAiCompatible) {
    return buildOpenAiCompatibleSetupDescriptor(openAiCompatible);
  }

  return SETUP_MODEL_PROVIDER_CATALOG[0]!;
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

  const resolvedProviderId =
    providerId === 'bedrock-mantle' ? 'amazon-bedrock' : providerId;
  const builtin = SETUP_MODEL_PROVIDER_BY_ID.get(
    resolvedProviderId as BuiltinSetupModelProviderId,
  );

  if (builtin) {
    return builtin.label;
  }

  const openAiCompatible =
    getOpenAiCompatibleProviderInstance(resolvedProviderId);
  if (openAiCompatible) {
    return openAiCompatible.label;
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
    xaiSubscriptionConnected?: boolean;
    xaiConnected?: boolean;
  },
): string | null {
  const normalizedModelId = normalizeOptionalString(modelId);

  if (!normalizedModelId) {
    return null;
  }

  const runtimeProviderId = getTaskModelProviderId(normalizedModelId);

  if (runtimeProviderId === 'bedrock-mantle') {
    return 'amazon-bedrock';
  }

  if (
    runtimeProviderId === 'openai' &&
    options?.chatgptConnected &&
    !options?.openaiConnected
  ) {
    return CHATGPT_SUBSCRIPTION_PROVIDER_ID;
  }

  // Mirror the ChatGPT/OpenAI relationship: `xai/` models group under the
  // Grok subscription when it is the only xAI-facing connection, and stay
  // under the native xAI group when an API key is also present.
  if (
    runtimeProviderId === 'xai' &&
    options?.xaiSubscriptionConnected &&
    !options?.xaiConnected
  ) {
    return XAI_SUBSCRIPTION_PROVIDER_ID;
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
    xaiSubscriptionConnected?: boolean;
    xaiConnected?: boolean;
  },
): DisplayModelProviderGroup<T>[] {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const providerId = getDisplayModelProviderId(item.id, options) ?? 'other';
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

  const catalogMatch = SETUP_MODEL_PROVIDER_CATALOG.find(
    (provider) => provider.envVarName === normalizedName,
  );

  if (catalogMatch) {
    return catalogMatch;
  }

  const openAiCompatible = listOpenAiCompatibleProviderInstancesFromEnvNames([
    normalizedName,
  ])[0];

  return openAiCompatible
    ? buildOpenAiCompatibleSetupDescriptor(openAiCompatible)
    : undefined;
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

  if (
    SETUP_MODEL_PROVIDER_BY_ID.has(providerId as BuiltinSetupModelProviderId)
  ) {
    return providerId as SetupModelProviderId;
  }

  if (isOpenAiCompatibleProviderId(providerId)) {
    return providerId as SetupModelProviderId;
  }

  return null;
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

  const openAiCompatible =
    normalizedProviderId && isOpenAiCompatibleProviderId(normalizedProviderId)
      ? getOpenAiCompatibleProviderInstance(normalizedProviderId)
      : null;

  return [
    ...new Set([
      ...(normalizedProviderId
        ? (MODEL_PROVIDER_ENV_KEYS_BY_PROVIDER.get(normalizedProviderId) ?? [])
        : []),
      ...(openAiCompatible
        ? [
            openAiCompatible.baseUrlEnvVarName,
            openAiCompatible.apiKeyEnvVarName,
          ]
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
    // Endpoint providers sometimes surface the primary base URL in UI-side
    // additionalEnvValues for display; ignore that key instead of rejecting.
    if (provider.authKind === 'endpoint' && name === providerEnvVarName) {
      continue;
    }

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
      if (field.options && field.options.length > 0) {
        const allowed = new Set(field.options.map((option) => option.value));
        if (!allowed.has(value)) {
          throw new Error(
            `Enter a valid ${field.label} for ${provider.label} to ${options.action}.`,
          );
        }
      }
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
  githubCopilotConnected?: boolean;
  xaiSubscriptionConnected?: boolean;
}): SetupModelStatus {
  const runtimeEnv = input.runtimeEnv ?? {};
  const chatgptConnected = Boolean(input.chatgptConnected);
  const githubCopilotConnected = Boolean(input.githubCopilotConnected);
  const xaiSubscriptionConnected = Boolean(input.xaiSubscriptionConnected);
  const persistedModelConfig = normalizeDeploymentModelConfig(
    input.persistedModelConfig,
  );
  const persistedEnvVarNameSet = new Set(
    Array.from(input.persistedEnvVarNames ?? []).map((name) => name.trim()),
  );
  // Bare R_MODEL / saved coding models are LiteLLM route names when a LiteLLM
  // endpoint is present; rewrite before provider resolution so setup status
  // matches task runtime resolution.
  const isLiteLlmConfigured =
    isConfiguredEnvValue(runtimeEnv.LITELLM_BASE_URL) ||
    persistedEnvVarNameSet.has('LITELLM_BASE_URL') ||
    isConfiguredEnvValue(input.persistedEnvVarValues?.LITELLM_BASE_URL);
  const runtimeRoomoteModelRaw = normalizeOptionalString(runtimeEnv.R_MODEL);
  const runtimeRoomoteModel = runtimeRoomoteModelRaw
    ? applyImplicitLiteLlmModelPrefix(
        runtimeRoomoteModelRaw,
        isLiteLlmConfigured,
      )
    : null;
  const runtimeRoomoteModelSatisfied = runtimeRoomoteModel !== null;
  const runtimeProviderId =
    resolveModelProviderIdFromModel(runtimeRoomoteModel);
  const runtimeKnownProviderId =
    resolveSetupModelProviderIdFromModel(runtimeRoomoteModel);
  const persistedRoomoteModel = persistedModelConfig.roomoteModel
    ? applyImplicitLiteLlmModelPrefix(
        persistedModelConfig.roomoteModel,
        isLiteLlmConfigured,
      )
    : null;
  const persistedProviderId = resolveSetupModelProviderIdFromModel(
    persistedRoomoteModel,
  );

  const preselectedProvider =
    runtimeKnownProviderId ??
    input.selectedProvider ??
    persistedProviderId ??
    DEFAULT_SETUP_MODEL_PROVIDER_ID;

  const buildProviderStatus = (
    provider: SetupModelProviderDescriptor,
  ): SetupModelProviderStatus => {
    if (provider.authKind === 'oauth') {
      const oauthConnected =
        provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID
          ? chatgptConnected
          : provider.id === 'github-copilot'
            ? githubCopilotConnected
            : provider.id === XAI_SUBSCRIPTION_PROVIDER_ID
              ? xaiSubscriptionConnected
              : false;
      return {
        ...provider,
        additionalEnvValues: {},
        runtimeApiKeySatisfied: false,
        savedApiKeySatisfied: oauthConnected,
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

    const runtimeApiKeySatisfied =
      hasRequiredEnvVars && requiredEnvVarNames.every(isRuntimeConfigured);
    const savedApiKeySatisfied =
      hasRequiredEnvVars &&
      requiredEnvVarNames.every(
        (name) => isPersisted(name) || isRuntimeConfigured(name),
      ) &&
      requiredEnvVarNames.some(isPersisted);

    return {
      ...provider,
      additionalEnvValues,
      runtimeApiKeySatisfied,
      savedApiKeySatisfied,
    };
  };

  const discoveredOpenAiCompatibleIds = new Set(
    listOpenAiCompatibleProviderInstancesFromEnvNames([
      ...persistedEnvVarNameSet,
      ...Object.keys(runtimeEnv).filter((name) =>
        isConfiguredEnvValue(runtimeEnv[name]),
      ),
    ]).map((instance) => instance.id),
  );

  if (
    runtimeKnownProviderId &&
    isOpenAiCompatibleProviderId(runtimeKnownProviderId)
  ) {
    discoveredOpenAiCompatibleIds.add(runtimeKnownProviderId);
  }
  if (
    persistedProviderId &&
    isOpenAiCompatibleProviderId(persistedProviderId)
  ) {
    discoveredOpenAiCompatibleIds.add(persistedProviderId);
  }

  const providersById = new Map<string, SetupModelProviderStatus>();

  for (const provider of SETUP_MODEL_PROVIDER_CATALOG) {
    providersById.set(provider.id, buildProviderStatus(provider));
  }

  for (const providerId of discoveredOpenAiCompatibleIds) {
    if (providersById.has(providerId)) {
      continue;
    }

    const baseInstance = getOpenAiCompatibleProviderInstance(providerId);
    if (!baseInstance) {
      continue;
    }

    const labeledInstance = buildOpenAiCompatibleProviderInstance(
      baseInstance.slug,
      {
        label: baseInstance.labelEnvVarName
          ? (normalizeOptionalString(
              runtimeEnv[baseInstance.labelEnvVarName],
            ) ??
            normalizeOptionalString(
              input.persistedEnvVarValues?.[baseInstance.labelEnvVarName],
            ))
          : null,
      },
    );

    providersById.set(
      labeledInstance.id,
      buildProviderStatus(
        buildOpenAiCompatibleSetupDescriptor(labeledInstance),
      ),
    );
  }

  const providers = [...providersById.values()].filter(
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
  // without OPENAI_API_KEY. SuperGrok covers `xai/` the same way.
  const chatgptCoversOpenAi = chatgptConnected;
  const xaiSubscriptionCoversXai = xaiSubscriptionConnected;
  const openaiRuntimeSatisfied =
    runtimeProviderStatus?.id === 'openai'
      ? runtimeProviderStatus.runtimeApiKeySatisfied || chatgptCoversOpenAi
      : runtimeProviderStatus?.id === 'xai'
        ? runtimeProviderStatus.runtimeApiKeySatisfied ||
          xaiSubscriptionCoversXai
        : (runtimeProviderStatus?.runtimeApiKeySatisfied ?? false);
  const openaiPersistedSatisfied =
    persistedProviderStatus?.id === 'openai'
      ? persistedProviderStatus.savedApiKeySatisfied ||
        persistedProviderStatus.runtimeApiKeySatisfied ||
        chatgptCoversOpenAi
      : persistedProviderStatus?.id === 'xai'
        ? persistedProviderStatus.savedApiKeySatisfied ||
          persistedProviderStatus.runtimeApiKeySatisfied ||
          xaiSubscriptionCoversXai
        : (persistedProviderStatus?.savedApiKeySatisfied ??
          persistedProviderStatus?.runtimeApiKeySatisfied ??
          false);

  const setupSatisfiedByRuntimeEnv =
    runtimeRoomoteModelSatisfied && openaiRuntimeSatisfied;
  // The persisted model works with a key from either source: the effective
  // model runtime env resolves keys runtime-first with a DB fallback, so a
  // saved model choice plus a runtime-env key is a complete setup. A
  // ChatGPT subscription also satisfies persisted openai/ models; SuperGrok
  // does the same for xai/.
  // Symmetric: a runtime env model plus a saved provider key is also complete,
  // because task runtime resolution layer loads keys the same way.
  const setupSatisfiedByRuntimeModelAndSavedKey =
    runtimeRoomoteModelSatisfied &&
    Boolean(
      runtimeProviderStatus &&
      (runtimeProviderStatus.id === 'openai'
        ? runtimeProviderStatus.savedApiKeySatisfied || chatgptCoversOpenAi
        : runtimeProviderStatus.id === 'xai'
          ? runtimeProviderStatus.savedApiKeySatisfied ||
            xaiSubscriptionCoversXai
          : runtimeProviderStatus.savedApiKeySatisfied),
    );
  const setupSatisfied =
    setupSatisfiedByRuntimeEnv ||
    setupSatisfiedByRuntimeModelAndSavedKey ||
    Boolean(
      persistedRoomoteModel &&
      (openaiPersistedSatisfied ||
        (persistedProviderStatus?.id !== 'openai' &&
          persistedProviderStatus?.id !== 'xai' &&
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

  // Key presence for xAI is computed from env only so the UI can show the
  // API-key path separately from SuperGrok OAuth.
  const xaiApiKeyConnected = (() => {
    const required = getSetupModelProviderRequiredEnvVarNames(
      getSetupModelProvider('xai'),
    );
    if (required.length === 0) {
      return false;
    }
    const isRuntimeConfigured = (name: string) =>
      isConfiguredEnvValue(runtimeEnv[name]);
    const isPersisted = (name: string) => persistedEnvVarNameSet.has(name);
    return (
      required.every(
        (name) => isPersisted(name) || isRuntimeConfigured(name),
      ) &&
      required.some((name) => isPersisted(name) || isRuntimeConfigured(name))
    );
  })();

  return {
    runtimeRoomoteModel,
    runtimeRoomoteModelSatisfied,
    runtimeProviderId,
    persistedRoomoteModel,
    persistedProviderId,
    preselectedProvider,
    providers,
    setupSatisfied,
    setupSatisfiedByRuntimeEnv,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
    xaiApiKeyConnected,
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
