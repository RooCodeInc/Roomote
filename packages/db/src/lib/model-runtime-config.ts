import { eq } from 'drizzle-orm';
import {
  CHATGPT_OPENCODE_PROVIDER_ID,
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  getModelProviderEnvKeyCandidates,
  getTaskModelCatalog,
  isConfiguredEnvValue,
  normalizeDeploymentModelConfig,
  normalizeOptionalReasoningEffort,
  parseModelProviderEnvKeys,
  resolveSetupModelProviderIdFromModel,
  type TaskModelOption,
} from '@roomote/types';

import { decryptSecrets } from '../encryption';
import { resolveOpenCodeAuthContent } from './chatgpt-subscription';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';
import { stringifyDecryptedEnvVarValue } from './environment-variables';

const DEFAULT_DEPLOYMENT_ID = 'default';

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

export async function resolveEffectiveModelRuntimeEnv(
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    deploymentEnvVars?: Record<string, string>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<Record<string, string>> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const [persistedEnvVars, { runtimeModelConfig, catalogModels }] =
    await Promise.all([
      resolveEffectiveDeploymentEnvVars({
        deploymentEnvVars: options.deploymentEnvVars,
        executor,
      }),
      loadPersistedRuntimeModelConfig(executor),
    ]);
  const persistedRuntimeModelConfig = runtimeModelConfig;
  const resolvedRoomoteModel =
    normalizeConfiguredValue(runtimeEnv.ROOMOTE_MODEL) ??
    normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteModel);
  const resolvedRoomoteSmallModel =
    normalizeConfiguredValue(runtimeEnv.ROOMOTE_SMALL_MODEL) ??
    normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteSmallModel);
  const resolvedRoomoteVisionModel =
    normalizeConfiguredValue(runtimeEnv.ROOMOTE_VISION_MODEL) ??
    normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteVisionModel);
  const resolvedRoomoteCodeReviewModel =
    normalizeConfiguredValue(runtimeEnv.ROOMOTE_CODE_REVIEW_MODEL) ??
    normalizeConfiguredValue(
      persistedRuntimeModelConfig.roomoteCodeReviewModel,
    );
  const resolvedRoomoteExploreModel =
    normalizeConfiguredValue(runtimeEnv.ROOMOTE_EXPLORE_MODEL) ??
    normalizeConfiguredValue(persistedRuntimeModelConfig.roomoteExploreModel);
  const resolvedRoomotePlanningModel =
    normalizeConfiguredValue(runtimeEnv.ROOMOTE_PLANNING_MODEL) ??
    normalizeConfiguredValue(persistedRuntimeModelConfig.roomotePlanningModel);
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
    normalizeConfiguredReasoningEffort(
      runtimeEnv.ROOMOTE_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteModelReasoningEffort ??
    (modelSupportsReasoning(resolvedRoomoteModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.coding
      : undefined);
  const resolvedRoomoteSmallModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.ROOMOTE_SMALL_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteSmallModelReasoningEffort ??
    (modelSupportsReasoning(resolvedRoomoteSmallModel ?? resolvedRoomoteModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.helper
      : undefined);
  const resolvedRoomoteVisionModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.ROOMOTE_VISION_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteVisionModelReasoningEffort ??
    (resolvedRoomoteVisionModel &&
    modelSupportsReasoning(resolvedRoomoteVisionModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.vision
      : undefined);
  const resolvedRoomoteCodeReviewModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.ROOMOTE_CODE_REVIEW_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteCodeReviewModelReasoningEffort ??
    (modelSupportsReasoning(
      resolvedRoomoteCodeReviewModel ?? resolvedRoomoteModel,
    )
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.codeReview
      : undefined);
  const resolvedRoomoteExploreModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.ROOMOTE_EXPLORE_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomoteExploreModelReasoningEffort ??
    (modelSupportsReasoning(resolvedRoomoteExploreModel ?? resolvedRoomoteModel)
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.explore
      : undefined);
  const resolvedRoomotePlanningModelReasoningEffort =
    normalizeConfiguredReasoningEffort(
      runtimeEnv.ROOMOTE_PLANNING_MODEL_REASONING_EFFORT,
    ) ??
    persistedRuntimeModelConfig.roomotePlanningModelReasoningEffort ??
    (modelSupportsReasoning(
      resolvedRoomotePlanningModel ?? resolvedRoomoteModel,
    )
      ? DEFAULT_MODEL_ROLE_REASONING_EFFORTS.planning
      : undefined);
  const runtimeRoomoteModelEnvKeys = normalizeConfiguredValue(
    runtimeEnv.ROOMOTE_MODEL_ENV_KEYS,
  );
  const providerKeyNames = resolveProviderKeyNames({
    runtimeRoomoteModelEnvKeys,
    resolvedRoomoteModels: [
      resolvedRoomoteModel,
      resolvedRoomoteSmallModel,
      resolvedRoomoteVisionModel,
      resolvedRoomoteCodeReviewModel,
      resolvedRoomoteExploreModel,
      resolvedRoomotePlanningModel,
    ],
  });
  const resolvedProviderKeyValues = Object.fromEntries(
    providerKeyNames.flatMap((envVarName) => {
      const value =
        normalizeConfiguredValue(runtimeEnv[envVarName]) ??
        normalizeConfiguredValue(persistedEnvVars[envVarName]);

      return value ? [[envVarName, value]] : [];
    }),
  );

  // ChatGPT subscription coverage: when a connected subscription exists and
  // any resolved role model uses the `openai/` prefix, inject the OAuth
  // record as `OPENCODE_AUTH_CONTENT`. opencode's Codex plugin prefers OAuth
  // auth when present, so the subscription wins over `OPENAI_API_KEY` at
  // runtime even when both are configured. This single choke point covers
  // both task launches (dequeue-helpers) and routing/title/summary calls
  // (non-task-provider-usage).
  const resolvedRoleModels = [
    resolvedRoomoteModel,
    resolvedRoomoteSmallModel,
    resolvedRoomoteVisionModel,
    resolvedRoomoteCodeReviewModel,
    resolvedRoomoteExploreModel,
    resolvedRoomotePlanningModel,
  ];
  const usesOpenAiModel = resolvedRoleModels.some(
    (modelId) =>
      typeof modelId === 'string' &&
      modelId.startsWith(`${CHATGPT_OPENCODE_PROVIDER_ID}/`),
  );
  const injectedOpenCodeAuthContent = usesOpenAiModel
    ? await resolveOpenCodeAuthContent({ executor })
    : null;

  return {
    ...(resolvedRoomoteModel && { ROOMOTE_MODEL: resolvedRoomoteModel }),
    ...(resolvedRoomoteSmallModel && {
      ROOMOTE_SMALL_MODEL: resolvedRoomoteSmallModel,
    }),
    ...(resolvedRoomoteVisionModel && {
      ROOMOTE_VISION_MODEL: resolvedRoomoteVisionModel,
    }),
    ...(resolvedRoomoteCodeReviewModel && {
      ROOMOTE_CODE_REVIEW_MODEL: resolvedRoomoteCodeReviewModel,
    }),
    ...(resolvedRoomoteExploreModel && {
      ROOMOTE_EXPLORE_MODEL: resolvedRoomoteExploreModel,
    }),
    ...(resolvedRoomotePlanningModel && {
      ROOMOTE_PLANNING_MODEL: resolvedRoomotePlanningModel,
    }),
    ...(resolvedRoomoteModelReasoningEffort && {
      ROOMOTE_MODEL_REASONING_EFFORT: resolvedRoomoteModelReasoningEffort,
    }),
    ...(resolvedRoomoteSmallModelReasoningEffort && {
      ROOMOTE_SMALL_MODEL_REASONING_EFFORT:
        resolvedRoomoteSmallModelReasoningEffort,
    }),
    ...(resolvedRoomoteVisionModelReasoningEffort && {
      ROOMOTE_VISION_MODEL_REASONING_EFFORT:
        resolvedRoomoteVisionModelReasoningEffort,
    }),
    ...(resolvedRoomoteCodeReviewModelReasoningEffort && {
      ROOMOTE_CODE_REVIEW_MODEL_REASONING_EFFORT:
        resolvedRoomoteCodeReviewModelReasoningEffort,
    }),
    ...(resolvedRoomoteExploreModelReasoningEffort && {
      ROOMOTE_EXPLORE_MODEL_REASONING_EFFORT:
        resolvedRoomoteExploreModelReasoningEffort,
    }),
    ...(resolvedRoomotePlanningModelReasoningEffort && {
      ROOMOTE_PLANNING_MODEL_REASONING_EFFORT:
        resolvedRoomotePlanningModelReasoningEffort,
    }),
    ...(runtimeRoomoteModelEnvKeys && {
      ROOMOTE_MODEL_ENV_KEYS: runtimeRoomoteModelEnvKeys,
    }),
    ...(!runtimeRoomoteModelEnvKeys &&
      providerKeyNames.length > 0 && {
        ROOMOTE_MODEL_ENV_KEYS: providerKeyNames.join(','),
      }),
    ...resolvedProviderKeyValues,
    ...(injectedOpenCodeAuthContent && {
      OPENCODE_AUTH_CONTENT: injectedOpenCodeAuthContent,
    }),
  };
}
