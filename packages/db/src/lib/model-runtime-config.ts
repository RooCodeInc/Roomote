import { eq } from 'drizzle-orm';
import {
  applyImplicitLiteLlmModelPrefix,
  CHATGPT_OPENCODE_PROVIDER_ID,
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
  getEnabledTaskModels,
  getModelProviderEnvKeyCandidates,
  getTaskModelCatalog,
  INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME,
  INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME,
  INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME,
  isConfiguredEnvValue,
  isInferenceGatewayCoveredEnvVar,
  normalizeDeploymentModelConfig,
  normalizeOptionalReasoningEffort,
  parseModelProviderEnvKeys,
  resolveSetupModelProviderIdFromModel,
  type TaskModelOption,
} from '@roomote/types';

import { decryptSecrets } from '../encryption';
import { resolveOpenCodeAuthContent } from './chatgpt-subscription';
import { resolveGitHubCopilotOpenCodeAuthContent } from './github-copilot-subscription';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';
import {
  resolveDeploymentEnvVar,
  stringifyDecryptedEnvVarValue,
} from './environment-variables';

const DEFAULT_DEPLOYMENT_ID = 'default';
const DISABLED_MODEL_PROVIDER_ENV_VAR_NAME_SET = new Set<string>(
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
);

async function loadPersistedDeploymentEnvVars(
  executor: DatabaseOrTransaction = db,
): Promise<Record<string, string>> {
  const encryptedEnvVars = await executor.query.environmentVariables.findMany();
  const decryptedEnvVars = await Promise.all(
    encryptedEnvVars.map(async ({ name, value }) => ({
      name,
      value: await decryptSecrets<string>(value),
    })),
  );

  return decryptedEnvVars
    .filter(
      (envVar): envVar is { name: string; value: string } =>
        envVar.value !== null,
    )
    .reduce(
      (acc, { name, value }) => {
        acc[name] = stringifyDecryptedEnvVarValue(value);
        return acc;
      },
      {} as Record<string, string>,
    );
}

export async function resolveEffectiveDeploymentEnvVars(
  options: {
    deploymentEnvVars?: Record<string, string>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<Record<string, string>> {
  if (options.deploymentEnvVars) {
    return options.deploymentEnvVars;
  }

  return loadPersistedDeploymentEnvVars(options.executor ?? db);
}

async function loadPersistedRuntimeModelConfig(
  executor: DatabaseOrTransaction = db,
) {
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      runtimeModelConfig: true,
      taskModelSettings: true,
    },
  });

  return {
    runtimeModelConfig: normalizeDeploymentModelConfig(
      deployment?.runtimeModelConfig,
    ),
    catalogModels: getTaskModelCatalog(deployment?.taskModelSettings),
    enabledCatalogModels: getEnabledTaskModels(deployment?.taskModelSettings),
  };
}

function normalizeConfiguredValue(
  value: string | null | undefined,
): string | undefined {
  return isConfiguredEnvValue(value) ? value.trim() : undefined;
}

function normalizeConfiguredReasoningEffort(
  value: string | null | undefined,
): string | undefined {
  return (
    normalizeOptionalReasoningEffort(normalizeConfiguredValue(value)) ??
    undefined
  );
}

function resolveProviderKeyNames({
  runtimeRoomoteModelEnvKeys,
  resolvedRoomoteModels,
}: {
  runtimeRoomoteModelEnvKeys?: string;
  resolvedRoomoteModels: Array<string | undefined>;
}): string[] {
  const configuredProviderKeys = parseModelProviderEnvKeys(
    runtimeRoomoteModelEnvKeys,
  ).filter(
    (envVarName) => !DISABLED_MODEL_PROVIDER_ENV_VAR_NAME_SET.has(envVarName),
  );

  if (configuredProviderKeys.length > 0) {
    return configuredProviderKeys;
  }

  const providerIds = resolvedRoomoteModels.flatMap((model) => {
    const providerId = resolveSetupModelProviderIdFromModel(model);

    return providerId ? [providerId] : [];
  });

  return [
    ...new Set(
      providerIds.flatMap((providerId) =>
        getModelProviderEnvKeyCandidates({ providerId }),
      ),
    ),
  ];
}

/**
 * Resolve a single model-provider env value with the same precedence the task
 * runtime uses: the runtime process env first, then the persisted (encrypted)
 * deployment environment variables.
 */
export async function resolveModelProviderEnvValue(
  envVarNames: string | readonly string[],
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<string | undefined> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const names = typeof envVarNames === 'string' ? [envVarNames] : envVarNames;

  for (const envVarName of names) {
    const runtimeValue = normalizeConfiguredValue(runtimeEnv[envVarName]);

    if (runtimeValue) {
      return runtimeValue;
    }
  }

  for (const envVarName of names) {
    const persistedValue = await resolveDeploymentEnvVar(
      envVarName,
      options.executor ?? db,
      {},
    );

    const normalizedValue = normalizeConfiguredValue(persistedValue);

    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return undefined;
}

type ModelRuntimeEnvOptions = {
  runtimeEnv?: Partial<Record<string, string | undefined>>;
  deploymentEnvVars?: Record<string, string>;
  executor?: DatabaseOrTransaction;
};

/**
 * Resolve model runtime env for control-plane inference (routing, titles,
 * summaries): raw provider keys are returned because control-plane calls
 * hold no run token to present to the inference gateway.
 */
export async function resolveEffectiveModelRuntimeEnv(
  options: ModelRuntimeEnvOptions = {},
): Promise<Record<string, string>> {
  return resolveModelRuntimeEnv(options, { inferenceGateway: false });
}

/**
 * Resolve model runtime env for a task sandbox: the configured provider keys
 * the inference gateway can serve stay on the control plane and their names
 * are advertised via `R_INFERENCE_GATEWAY_KEYS` instead, and a connected
 * ChatGPT subscription is routed through the gateway rather than
 * materializing `OPENCODE_AUTH_CONTENT` in the sandbox.
 */
export async function resolveSandboxModelRuntimeEnv(
  options: ModelRuntimeEnvOptions = {},
): Promise<Record<string, string>> {
  return resolveModelRuntimeEnv(options, { inferenceGateway: true });
}

async function resolveModelRuntimeEnv(
  options: ModelRuntimeEnvOptions,
  { inferenceGateway }: { inferenceGateway: boolean },
): Promise<Record<string, string>> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const [
    persistedEnvVars,
    { runtimeModelConfig, catalogModels, enabledCatalogModels },
  ] = await Promise.all([
    resolveEffectiveDeploymentEnvVars({
      deploymentEnvVars: options.deploymentEnvVars,
      executor,
    }),
    loadPersistedRuntimeModelConfig(executor),
  ]);
  const persistedRuntimeModelConfig = runtimeModelConfig;
  const runtimeOverrideModelConfig = normalizeDeploymentModelConfig({
    roomoteModel: runtimeEnv.R_MODEL,
    roomoteSmallModel: runtimeEnv.R_SMALL_MODEL,
    roomoteVisionModel: runtimeEnv.R_VISION_MODEL,
    roomoteCodeReviewModel: runtimeEnv.R_CODE_REVIEW_MODEL,
    roomoteExploreModel: runtimeEnv.R_EXPLORE_MODEL,
    roomotePlanningModel: runtimeEnv.R_PLANNING_MODEL,
  });
  // Bare R_MODEL values are valid LiteLLM route names when a LiteLLM endpoint
  // is configured; rewrite them to OpenCode's litellm/<name> form before key
  // resolution so provider credentials and sandbox validation stay aligned.
  const isLiteLlmConfigured = Boolean(
    normalizeConfiguredValue(runtimeEnv.LITELLM_BASE_URL) ??
    normalizeConfiguredValue(persistedEnvVars.LITELLM_BASE_URL),
  );
  const withLiteLlmPrefix = (modelId: string | undefined): string | undefined =>
    modelId
      ? applyImplicitLiteLlmModelPrefix(modelId, isLiteLlmConfigured)
      : undefined;
  const resolvedRoomoteModel = withLiteLlmPrefix(
    runtimeOverrideModelConfig.roomoteModel ??
      normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteModel),
  );
  const resolvedRoomoteSmallModel = withLiteLlmPrefix(
    runtimeOverrideModelConfig.roomoteSmallModel ??
      normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteSmallModel),
  );
  const resolvedRoomoteVisionModel = withLiteLlmPrefix(
    runtimeOverrideModelConfig.roomoteVisionModel ??
      normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteVisionModel),
  );
  const resolvedRoomoteCodeReviewModel = withLiteLlmPrefix(
    runtimeOverrideModelConfig.roomoteCodeReviewModel ??
      normalizeConfiguredValue(
        persistedRuntimeModelConfig.roomoteCodeReviewModel,
      ),
  );
  const resolvedRoomoteExploreModel = withLiteLlmPrefix(
    runtimeOverrideModelConfig.roomoteExploreModel ??
      normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteExploreModel),
  );
  const resolvedRoomotePlanningModel = withLiteLlmPrefix(
    runtimeOverrideModelConfig.roomotePlanningModel ??
      normalizeConfiguredValue(
        persistedRuntimeModelConfig.roomotePlanningModel,
      ),
  );
  // Roomote applies per-role reasoning defaults when no explicit level is
  // configured, but only for models that are not known to lack configurable
  // reasoning support (unknown support keeps the default, matching the UI).
  const modelSupportsReasoning = (modelId: string | undefined): boolean => {
    if (!modelId) {
      return false;
    }

    const catalogModel: TaskModelOption | undefined = catalogModels.find(
      (model) => model.id === modelId,
    );

    return catalogModel?.metadata?.supportsReasoning !== false;
  };
  const resolvedRoomoteModelReasoningEffort =
    normalizeConfiguredReasoningEffort(runtimeEnv.R_MODEL_REASONING_EFFORT) ??
    persistedRuntimeModelConfig.roomoteModelReasoningEffort ??
    (modelSupportsReasoning(resolvedRoomoteModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.coding
      : undefined);
  const resolvedRoomoteSmallModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.R_SMALL_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteSmallModelReasoningEffort ??
    (modelSupportsReasoning(resolvedRoomoteSmallModel ?? resolvedRoomoteModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.helper
      : undefined);
  const resolvedRoomoteVisionModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.R_VISION_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteVisionModelReasoningEffort ??
    (resolvedRoomoteVisionModel &&
    modelSupportsReasoning(resolvedRoomoteVisionModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.vision
      : undefined);
  const resolvedRoomoteCodeReviewModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.R_CODE_REVIEW_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteCodeReviewModelReasoningEffort ??
    (modelSupportsReasoning(
      resolvedRoomoteCodeReviewModel ?? resolvedRoomoteModel,
    )
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.codeReview
      : undefined);
  const resolvedRoomoteExploreModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.R_EXPLORE_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteExploreModelReasoningEffort ??
    (modelSupportsReasoning(resolvedRoomoteExploreModel ?? resolvedRoomoteModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.explore
      : undefined);
  const resolvedRoomotePlanningModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.R_PLANNING_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomotePlanningModelReasoningEffort ??
    (modelSupportsReasoning(
      resolvedRoomotePlanningModel ?? resolvedRoomoteModel,
    )
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.planning
      : undefined);
  const configuredRoomoteModelEnvKeys =
    normalizeConfiguredValue(runtimeEnv.R_MODEL_ENV_KEYS) ??
    normalizeConfiguredValue(persistedEnvVars.R_MODEL_ENV_KEYS);
  const resolvedRoleModels = [
    resolvedRoomoteModel,
    resolvedRoomoteSmallModel,
    resolvedRoomoteVisionModel,
    resolvedRoomoteCodeReviewModel,
    resolvedRoomoteExploreModel,
    resolvedRoomotePlanningModel,
  ];
  const providerKeyNames = resolveProviderKeyNames({
    runtimeRoomoteModelEnvKeys: configuredRoomoteModelEnvKeys,
    resolvedRoomoteModels: resolvedRoleModels,
  });
  // A running OpenCode task can switch to any enabled catalog model without
  // another dequeue, while configured role agents can select their own
  // providers. Gateway coverage must therefore include both sets up front;
  // otherwise a later model switch either sees a missing key or uses a raw
  // provider credential that was already written into the sandbox.
  const gatewaySwitchableModelIds = inferenceGateway
    ? enabledCatalogModels.map((model) => model.id)
    : [];
  const gatewayProviderKeyNames = [
    ...new Set([
      ...providerKeyNames,
      ...resolveProviderKeyNames({
        resolvedRoomoteModels: gatewaySwitchableModelIds,
      }),
    ]),
  ];
  // When the gateway is active, the configured provider keys it can serve
  // (OpenRouter, Anthropic, OpenAI, Gemini, the aggregators, Bedrock) stay on
  // the control plane and are advertised to the worker by name via
  // R_INFERENCE_GATEWAY_KEYS; the worker builds the (container-reachable)
  // gateway URL from its own platform URL and rebases exactly these providers.
  // Only configured keys are withheld; credentials for disabled providers are
  // filtered before this point and never flow to the task runtime.
  const gatewayServedKeyNames = inferenceGateway
    ? gatewayProviderKeyNames.filter(
        (name) =>
          isInferenceGatewayCoveredEnvVar(name) &&
          (normalizeConfiguredValue(runtimeEnv[name]) !== undefined ||
            normalizeConfiguredValue(persistedEnvVars[name]) !== undefined),
      )
    : [];
  const gatewayServedKeyNameSet = new Set(gatewayServedKeyNames);

  const resolvedProviderKeyValues = Object.fromEntries(
    providerKeyNames.flatMap((envVarName) => {
      if (gatewayServedKeyNameSet.has(envVarName)) {
        return [];
      }

      const value =
        normalizeConfiguredValue(runtimeEnv[envVarName]) ??
        normalizeConfiguredValue(persistedEnvVars[envVarName]);

      return value ? [[envVarName, value]] : [];
    }),
  );

  // ChatGPT subscription coverage: when a connected subscription exists and
  // any resolved role or gateway-switchable model uses the `openai/` prefix,
  // inject the OAuth record as `OPENCODE_AUTH_CONTENT`. opencode's Codex
  // plugin prefers OAuth auth when present, so the subscription wins over
  // `OPENAI_API_KEY` at runtime even when both are configured. This single
  // choke point covers both task launches (dequeue-helpers) and
  // routing/title/summary calls (non-task-provider-usage).
  //
  // In sandbox gateway mode the OAuth record must stay on the control plane,
  // so instead of shipping OPENCODE_AUTH_CONTENT the resolver emits the
  // R_INFERENCE_GATEWAY_CHATGPT marker; the worker rebases the `openai`
  // provider onto the gateway, which mints and injects the access token.
  const usesOpenAiModel = [
    ...resolvedRoleModels,
    ...gatewaySwitchableModelIds,
  ].some(
    (modelId) =>
      typeof modelId === 'string' &&
      modelId.startsWith(`${CHATGPT_OPENCODE_PROVIDER_ID}/`),
  );
  const injectedOpenCodeAuthContent = usesOpenAiModel
    ? await resolveOpenCodeAuthContent({ executor })
    : null;
  const routeChatGptThroughGateway =
    inferenceGateway && injectedOpenCodeAuthContent != null;
  const usesGitHubCopilotModel = [
    ...resolvedRoleModels,
    ...gatewaySwitchableModelIds,
  ].some(
    (modelId) =>
      typeof modelId === 'string' && modelId.startsWith('github-copilot/'),
  );
  const githubCopilotAuthContent = usesGitHubCopilotModel
    ? await resolveGitHubCopilotOpenCodeAuthContent(executor)
    : null;
  const routeGitHubCopilotThroughGateway =
    inferenceGateway && githubCopilotAuthContent != null;
  const directOpenCodeAuthContent = [
    injectedOpenCodeAuthContent,
    githubCopilotAuthContent,
  ].reduce<Record<string, unknown>>((merged, content) => {
    return content ? { ...merged, ...JSON.parse(content) } : merged;
  }, {});

  return {
    ...(resolvedRoomoteModel && { R_MODEL: resolvedRoomoteModel }),
    ...(resolvedRoomoteSmallModel && {
      R_SMALL_MODEL: resolvedRoomoteSmallModel,
    }),
    ...(resolvedRoomoteVisionModel && {
      R_VISION_MODEL: resolvedRoomoteVisionModel,
    }),
    ...(resolvedRoomoteCodeReviewModel && {
      R_CODE_REVIEW_MODEL: resolvedRoomoteCodeReviewModel,
    }),
    ...(resolvedRoomoteExploreModel && {
      R_EXPLORE_MODEL: resolvedRoomoteExploreModel,
    }),
    ...(resolvedRoomotePlanningModel && {
      R_PLANNING_MODEL: resolvedRoomotePlanningModel,
    }),
    ...(resolvedRoomoteModelReasoningEffort && {
      R_MODEL_REASONING_EFFORT: resolvedRoomoteModelReasoningEffort,
    }),
    ...(resolvedRoomoteSmallModelReasoningEffort && {
      R_SMALL_MODEL_REASONING_EFFORT: resolvedRoomoteSmallModelReasoningEffort,
    }),
    ...(resolvedRoomoteVisionModelReasoningEffort && {
      R_VISION_MODEL_REASONING_EFFORT:
        resolvedRoomoteVisionModelReasoningEffort,
    }),
    ...(resolvedRoomoteCodeReviewModelReasoningEffort && {
      R_CODE_REVIEW_MODEL_REASONING_EFFORT:
        resolvedRoomoteCodeReviewModelReasoningEffort,
    }),
    ...(resolvedRoomoteExploreModelReasoningEffort && {
      R_EXPLORE_MODEL_REASONING_EFFORT:
        resolvedRoomoteExploreModelReasoningEffort,
    }),
    ...(resolvedRoomotePlanningModelReasoningEffort && {
      R_PLANNING_MODEL_REASONING_EFFORT:
        resolvedRoomotePlanningModelReasoningEffort,
    }),
    ...(providerKeyNames.length > 0 && {
      R_MODEL_ENV_KEYS: providerKeyNames.join(','),
    }),
    ...resolvedProviderKeyValues,
    ...(gatewayServedKeyNames.length > 0 && {
      [INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME]: gatewayServedKeyNames.join(','),
    }),
    ...(routeChatGptThroughGateway
      ? { [INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME]: '1' }
      : {}),
    ...(routeGitHubCopilotThroughGateway
      ? { [INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME]: '1' }
      : {}),
    ...(!routeChatGptThroughGateway &&
    !routeGitHubCopilotThroughGateway &&
    Object.keys(directOpenCodeAuthContent).length > 0
      ? { OPENCODE_AUTH_CONTENT: JSON.stringify(directOpenCodeAuthContent) }
      : {}),
  };
}
