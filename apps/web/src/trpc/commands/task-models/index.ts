import {
  and,
  db,
  deploymentSettings,
  environmentVariables,
  eq,
  inArray,
  isChatGptSubscriptionConnected,
  isGitHubCopilotSubscriptionConnected,
  isXaiSubscriptionConnected,
  isNull,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  TASK_MODEL_CATALOG,
  SETUP_MODEL_PROVIDER_CATALOG,
  buildOpenAiCompatibleProviderId,
  buildOpenAiCompatibleProviderInstance,
  buildSetupModelStatus,
  buildTaskModelOption,
  collectSetupModelProviderCredentialValues,
  getDefaultTaskModel,
  getSetupModelProviderAdditionalEnvFields,
  getSetupModelProviderEnvVarNames,
  getSetupModelProvider,
  getTaskModelCatalog,
  getTaskModelProviderId,
  getEnabledTaskModels,
  isConfiguredEnvValue,
  isOpenAiCompatibleProviderId,
  isTaskModelIdDisabled,
  normalizeOpenAiCompatibleConnectionSlug,
  normalizeOptionalReasoningEffort,
  normalizeSetupNewState,
  normalizeTaskModelId,
  normalizeTaskModelSettings,
} from '@roomote/types';
import type {
  DeploymentModelConfig,
  ReasoningEffort,
  SetupModelProviderId,
  SetupModelStatus,
  TaskModelInputType,
  TaskModelMetadata,
  TaskModelOption,
} from '@roomote/types';

import {
  getDeploymentRuntimeModelConfig,
  getDeploymentTaskModelSettings,
} from '@/lib/server/task-models';
import {
  getPersistedEnvironmentVariableValues,
  getPersistedEnvironmentVariableNames,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';
import {
  fetchModelsDevCatalog,
  lookupModelMetadataFromCatalog,
  mergeMetadata,
  suggestModelsFromCatalog,
} from './models-dev';
import {
  appendRecommendedTaskModels,
  appendSelectedTaskModels,
  buildAutoAddedTaskModelSettings,
  collectConnectedTaskModelProviderIds,
} from './auto-add-models';
import {
  discoverProviderModels,
  getLocalTaskModelProviderIdFromModelId,
  qualifyProviderModel,
  type LocalProviderConnectionInput,
  type LocalTaskModelProviderId,
  type TaskModelLookupResult,
} from './local-provider-discovery';
import type { UserAuthSuccess } from '@/types';

const DEFAULT_DEPLOYMENT_ID = 'default';
const MODEL_METADATA_FETCH_TIMEOUT_MS = 10_000;

function assertAdmin(auth: UserAuthSuccess): asserts auth is UserAuthSuccess {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

type RuntimeModelFieldStatus = {
  effectiveModelId: string | null;
  persistedModelId: string | null;
  source: 'env' | 'database' | 'default' | 'same-as-coding';
  managedByEnv: boolean;
  reasoningEffort: ReasoningEffort | null;
  reasoningManagedByEnv: boolean;
};

type TaskModelSettingsRuntimeStatus = {
  codingModel: RuntimeModelFieldStatus;
  helperModel: RuntimeModelFieldStatus;
  visionModel: RuntimeModelFieldStatus;
  codeReviewModel: RuntimeModelFieldStatus;
  exploreModel: RuntimeModelFieldStatus;
  planningModel: RuntimeModelFieldStatus;
};

type TaskModelSettingsResult = {
  defaultModelId: string;
  models: Array<{
    id: string;
    displayName: string;
    family: string;
    metadata: TaskModelMetadata | null;
    enabled: boolean;
    isDefault: boolean;
  }>;
  runtimeModels: TaskModelSettingsRuntimeStatus;
  helperModelOptions: Array<{
    id: string;
    displayName: string;
    family: string;
  }>;
};

type TaskModelSuggestionResult = {
  suggestions: Array<{
    slug: string;
    displayName: string;
  }>;
};

/**
 * Resolves the env override for a reasoning-effort variable. Only a valid
 * `ReasoningEffort` value counts as env-managed, and the read path
 * (`resolveRuntimeReasoningStatus`) and write path
 * (`updateTaskModelSettingsCommand`) must agree on this so the UI never shows
 * an editable selector whose saves would be discarded.
 */
function resolveEnvReasoningEffort(envVarName: string): ReasoningEffort | null {
  return isConfiguredEnvValue(process.env[envVarName])
    ? normalizeOptionalReasoningEffort(process.env[envVarName]!.trim())
    : null;
}

function resolveRuntimeReasoningStatus(
  envVarName: string,
  persistedReasoningEffort: ReasoningEffort | null,
): Pick<RuntimeModelFieldStatus, 'reasoningEffort' | 'reasoningManagedByEnv'> {
  const envReasoningEffort = resolveEnvReasoningEffort(envVarName);

  return {
    reasoningEffort: envReasoningEffort ?? persistedReasoningEffort,
    reasoningManagedByEnv: envReasoningEffort !== null,
  };
}

function resolveRuntimeModelStatus(options: {
  settingsDefaultModelId: string;
  persisted: DeploymentModelConfig;
}): TaskModelSettingsRuntimeStatus {
  const envCodingModel = isConfiguredEnvValue(process.env.R_MODEL)
    ? process.env.R_MODEL!.trim()
    : null;
  const envHelperModel = isConfiguredEnvValue(process.env.R_SMALL_MODEL)
    ? process.env.R_SMALL_MODEL!.trim()
    : null;
  const envVisionModel = isConfiguredEnvValue(process.env.R_VISION_MODEL)
    ? process.env.R_VISION_MODEL!.trim()
    : null;
  const envCodeReviewModel = isConfiguredEnvValue(
    process.env.R_CODE_REVIEW_MODEL,
  )
    ? process.env.R_CODE_REVIEW_MODEL!.trim()
    : null;
  const envExploreModel = isConfiguredEnvValue(process.env.R_EXPLORE_MODEL)
    ? process.env.R_EXPLORE_MODEL!.trim()
    : null;
  const envPlanningModel = isConfiguredEnvValue(process.env.R_PLANNING_MODEL)
    ? process.env.R_PLANNING_MODEL!.trim()
    : null;
  const persistedCodingModel = options.persisted.roomoteModel;
  const persistedHelperModel = options.persisted.roomoteSmallModel;
  const persistedVisionModel = options.persisted.roomoteVisionModel;
  const persistedCodeReviewModel = options.persisted.roomoteCodeReviewModel;
  const persistedExploreModel = options.persisted.roomoteExploreModel;
  const persistedPlanningModel = options.persisted.roomotePlanningModel;

  const codingEffective = envCodingModel ?? persistedCodingModel;
  const codingSource: RuntimeModelFieldStatus['source'] = envCodingModel
    ? 'env'
    : persistedCodingModel
      ? 'database'
      : 'default';
  const helperEffective = envHelperModel ?? persistedHelperModel;
  const helperSource: RuntimeModelFieldStatus['source'] = envHelperModel
    ? 'env'
    : persistedHelperModel
      ? 'database'
      : 'same-as-coding';
  const visionEffective = envVisionModel ?? persistedVisionModel;
  const visionSource: RuntimeModelFieldStatus['source'] = envVisionModel
    ? 'env'
    : persistedVisionModel
      ? 'database'
      : 'same-as-coding';
  const codeReviewEffective = envCodeReviewModel ?? persistedCodeReviewModel;
  const codeReviewSource: RuntimeModelFieldStatus['source'] = envCodeReviewModel
    ? 'env'
    : persistedCodeReviewModel
      ? 'database'
      : 'same-as-coding';
  const exploreEffective = envExploreModel ?? persistedExploreModel;
  const exploreSource: RuntimeModelFieldStatus['source'] = envExploreModel
    ? 'env'
    : persistedExploreModel
      ? 'database'
      : 'same-as-coding';
  const planningEffective = envPlanningModel ?? persistedPlanningModel;
  const planningSource: RuntimeModelFieldStatus['source'] = envPlanningModel
    ? 'env'
    : persistedPlanningModel
      ? 'database'
      : 'same-as-coding';

  return {
    codingModel: {
      effectiveModelId:
        codingEffective ?? options.settingsDefaultModelId ?? null,
      persistedModelId: persistedCodingModel,
      source: codingSource,
      managedByEnv: envCodingModel !== null,
      ...resolveRuntimeReasoningStatus(
        'R_MODEL_REASONING_EFFORT',
        options.persisted.roomoteModelReasoningEffort,
      ),
    },
    helperModel: {
      effectiveModelId: helperEffective,
      persistedModelId: persistedHelperModel,
      source: helperSource,
      managedByEnv: envHelperModel !== null,
      ...resolveRuntimeReasoningStatus(
        'R_SMALL_MODEL_REASONING_EFFORT',
        options.persisted.roomoteSmallModelReasoningEffort,
      ),
    },
    visionModel: {
      effectiveModelId: visionEffective,
      persistedModelId: persistedVisionModel,
      source: visionSource,
      managedByEnv: envVisionModel !== null,
      ...resolveRuntimeReasoningStatus(
        'R_VISION_MODEL_REASONING_EFFORT',
        options.persisted.roomoteVisionModelReasoningEffort,
      ),
    },
    codeReviewModel: {
      effectiveModelId: codeReviewEffective,
      persistedModelId: persistedCodeReviewModel,
      source: codeReviewSource,
      managedByEnv: envCodeReviewModel !== null,
      ...resolveRuntimeReasoningStatus(
        'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
        options.persisted.roomoteCodeReviewModelReasoningEffort,
      ),
    },
    exploreModel: {
      effectiveModelId: exploreEffective,
      persistedModelId: persistedExploreModel,
      source: exploreSource,
      managedByEnv: envExploreModel !== null,
      ...resolveRuntimeReasoningStatus(
        'R_EXPLORE_MODEL_REASONING_EFFORT',
        options.persisted.roomoteExploreModelReasoningEffort,
      ),
    },
    planningModel: {
      effectiveModelId: planningEffective,
      persistedModelId: persistedPlanningModel,
      source: planningSource,
      managedByEnv: envPlanningModel !== null,
      ...resolveRuntimeReasoningStatus(
        'R_PLANNING_MODEL_REASONING_EFFORT',
        options.persisted.roomotePlanningModelReasoningEffort,
      ),
    },
  };
}

export async function getTaskModelSettingsCommand(
  auth: UserAuthSuccess,
): Promise<TaskModelSettingsResult> {
  assertAdmin(auth);

  const [
    settings,
    persistedRuntimeModelConfig,
    persistedEnvVarNames,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
  ] = await Promise.all([
    getDeploymentTaskModelSettings(),
    getDeploymentRuntimeModelConfig(),
    getPersistedEnvironmentVariableNames(),
    isChatGptSubscriptionConnected(),
    isGitHubCopilotSubscriptionConnected(),
    isXaiSubscriptionConnected(),
  ]);
  // The Available Models list always shows the full recommended set for
  // every connected provider; entries that are not persisted yet render
  // disabled until an operator enables them.
  const connectedProviderIds = collectConnectedTaskModelProviderIds({
    runtimeEnv: process.env,
    persistedEnvVarNames,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
  });
  // Models selected for a runtime role (or as the default coding model) stay
  // listed and active even when a release drops them from the recommended
  // list, so their selectors keep rendering and saves keep validating.
  const selectedModelIds = new Set(
    [
      settings.defaultModelId,
      persistedRuntimeModelConfig.roomoteModel,
      persistedRuntimeModelConfig.roomoteSmallModel,
      persistedRuntimeModelConfig.roomoteVisionModel,
      persistedRuntimeModelConfig.roomoteCodeReviewModel,
      persistedRuntimeModelConfig.roomoteExploreModel,
      persistedRuntimeModelConfig.roomotePlanningModel,
    ]
      .filter((modelId): modelId is string => Boolean(modelId))
      .map(normalizeTaskModelId),
  );
  // A provider must be connected before its models can be selected. This also
  // removes stale rows created by the old implicit OpenRouter default catalog.
  const catalog = appendSelectedTaskModels({
    models: appendRecommendedTaskModels({
      models: getTaskModelCatalog(settings).filter((model) => {
        const providerId = getTaskModelProviderId(model.id);

        return providerId !== null && connectedProviderIds.has(providerId);
      }),
      connectedProviderIds,
    }),
    selectedModelIds,
    connectedProviderIds,
  });

  return {
    defaultModelId: settings.defaultModelId,
    models: catalog.map((option) => ({
      ...option,
      metadata: option.metadata ?? null,
      enabled:
        settings.allowedModelIds.includes(option.id) ||
        selectedModelIds.has(option.id),
      isDefault: settings.defaultModelId === option.id,
    })),
    runtimeModels: resolveRuntimeModelStatus({
      settingsDefaultModelId: settings.defaultModelId,
      persisted: persistedRuntimeModelConfig,
    }),
    helperModelOptions: catalog.map(({ id, displayName, family }) => ({
      id,
      displayName,
      family,
    })),
  };
}

async function getDeploymentSetupNewState(
  executor: DatabaseOrTransaction = db,
) {
  const [settings] = await executor
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .limit(1);

  return normalizeSetupNewState(settings?.setupNewState ?? {});
}

/**
 * Returns the raw `deployment_settings.task_model_settings` column value,
 * without the default-catalog fallback that `normalizeTaskModelSettings`
 * applies. Auto-adding recommended models needs to distinguish "operator
 * configured these models" from "deployment is still on the implicit
 * defaults". Also used by the setup wizard's model-config step.
 */
export async function getPersistedRawTaskModelSettings(
  executor: DatabaseOrTransaction = db,
): Promise<unknown> {
  const [settings] = await executor
    .select({ taskModelSettings: deploymentSettings.taskModelSettings })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .limit(1);

  return settings?.taskModelSettings ?? null;
}

/**
 * Returns the inference-provider setup status for the models settings page.
 * Mirrors the setup wizard's "Configure inference" step: per-provider
 * runtime/saved API key satisfaction plus the preselected provider.
 */
export async function getTaskModelProviderSetupCommand(
  auth: UserAuthSuccess,
): Promise<{ providerSetup: SetupModelStatus }> {
  assertAdmin(auth);

  const [
    persistedRuntimeModelConfig,
    persistedEnvVarNames,
    setupNewState,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
  ] = await Promise.all([
    getDeploymentRuntimeModelConfig(),
    getPersistedEnvironmentVariableNames(),
    getDeploymentSetupNewState(),
    isChatGptSubscriptionConnected(),
    isGitHubCopilotSubscriptionConnected(),
    isXaiSubscriptionConnected(),
  ]);

  // Include non-secret OpenAI-compatible env values (base URLs + connection
  // labels) for every discovered instance alongside the static catalog.
  const openAiCompatibleEnvNames = persistedEnvVarNames.filter((name) => {
    if (!name.startsWith('OPENAI_COMPATIBLE_')) {
      return false;
    }
    return (
      name.endsWith('_BASE_URL') ||
      name.endsWith('_LABEL') ||
      name === 'OPENAI_COMPATIBLE_BASE_URL'
    );
  });

  const catalogNonSecretEnvNames = SETUP_MODEL_PROVIDER_CATALOG.flatMap(
    (provider) => [
      ...(provider.authKind === 'endpoint' && provider.envVarName
        ? [provider.envVarName]
        : []),
      ...getSetupModelProviderAdditionalEnvFields(provider)
        .filter((field) => !field.secret)
        .map((field) => field.envVarName),
    ],
  );

  const persistedAdditionalEnvValues =
    await getPersistedEnvironmentVariableValues([
      ...new Set([...catalogNonSecretEnvNames, ...openAiCompatibleEnvNames]),
    ]);

  const providerSetup = buildSetupModelStatus({
    runtimeEnv: process.env,
    persistedModelConfig: persistedRuntimeModelConfig,
    persistedEnvVarNames,
    persistedEnvVarValues: persistedAdditionalEnvValues,
    selectedProvider: setupNewState.modelProvider,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
  });

  return { providerSetup };
}

/**
 * Saves the selected inference provider and, when given, its API key from the
 * models settings page. Unlike the setup wizard's `saveModelConfig`, this does
 * not reset the persisted runtime model config, so existing default, helper,
 * vision, and code review model choices are preserved.
 *
 * Connecting a provider the deployment has no models for yet also auto-adds
 * the provider's recommended models (see `buildAutoAddedTaskModelSettings`),
 * so the operator lands on a usable model list without picking models one by
 * one.
 */
export async function saveTaskModelProviderCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupModelProviderId;
    apiKey?: string;
    additionalEnvValues?: Record<string, string>;
    /**
     * Required when adding (or re-adding) an OpenAI-compatible connection.
     * Becomes the connection slug and display label.
     */
    connectionName?: string;
  },
): Promise<{
  providerSetup: SetupModelStatus;
  addedRecommendedModelCount: number;
  addedDiscoveredModelCount: number;
  discoveryError: string | null;
}> {
  assertAdmin(auth);

  let providerId = input.provider;
  let suppliedAdditionalEnvValues = input.additionalEnvValues;

  if (
    providerId === OPENAI_COMPATIBLE_PROVIDER_ID ||
    isOpenAiCompatibleProviderId(providerId)
  ) {
    // Adding a new named connection goes through the catalog template id plus
    // a connection name. Editing an existing bare `openai-compatible` row
    // (or saving without a name) keeps the default env vars. Named id edits
    // keep their existing id/env mapping as-is.
    if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
      const slug = normalizeOpenAiCompatibleConnectionSlug(
        input.connectionName,
      );

      if (slug) {
        providerId = buildOpenAiCompatibleProviderId(
          slug,
        ) as SetupModelProviderId;

        const instance = buildOpenAiCompatibleProviderInstance(slug, {
          label: input.connectionName?.trim() || slug,
        });
        // Remap values submitted against the catalog template env names onto
        // the named instance env vars.
        const template = getSetupModelProvider(OPENAI_COMPATIBLE_PROVIDER_ID);
        const remappedAdditional: Record<string, string> = {};
        if (instance.labelEnvVarName && input.connectionName?.trim()) {
          remappedAdditional[instance.labelEnvVarName] =
            input.connectionName.trim();
        }
        for (const [name, value] of Object.entries(
          input.additionalEnvValues ?? {},
        )) {
          if (name === 'OPENAI_COMPATIBLE_API_KEY') {
            remappedAdditional[instance.apiKeyEnvVarName] = value;
            continue;
          }
          if (template.envVarName && name === template.envVarName) {
            continue;
          }
          remappedAdditional[name] = value;
        }
        suppliedAdditionalEnvValues = remappedAdditional;
      } else if (input.connectionName?.trim()) {
        throw new Error(
          'Enter a valid connection name for the OpenAI-compatible endpoint.',
        );
      }
      // No connection name: keep the bare openai-compatible connection so
      // edit/save of the default endpoint still works.
    }
  }

  const provider = getSetupModelProvider(providerId);

  if (provider.authKind === 'oauth') {
    throw new Error(
      `${provider.label} is connected with a subscription account from the Models settings page and does not use an API key.`,
    );
  }

  // When remapping a newly named OpenAI-compatible connection,, rewrite the
  // primary base URL key by treating apiKey as the template primary value and
  // collecting against the named descriptor.
  const [chatgptConnected, xaiSubscriptionConnected] = await Promise.all([
    isChatGptSubscriptionConnected(),
    isXaiSubscriptionConnected(),
  ]);

  let addedRecommendedModelCount = 0;

  await db.transaction(async (tx) => {
    const [currentSetupNewState, persistedEnvVarNames, persistedTaskModels] =
      await Promise.all([
        getDeploymentSetupNewState(tx),
        getPersistedEnvironmentVariableNames(tx),
        getPersistedRawTaskModelSettings(tx),
      ]);
    const persistedEnvVarNameSet = new Set(persistedEnvVarNames);
    const { values: credentialValues, clearedEnvVarNames } =
      collectSetupModelProviderCredentialValues({
        provider,
        apiKey: input.apiKey,
        additionalEnvValues: suppliedAdditionalEnvValues,
        isEnvVarSatisfied: (envVarName) =>
          persistedEnvVarNameSet.has(envVarName) ||
          isConfiguredEnvValue(process.env[envVarName]),
        action: 'save it',
      });

    if (credentialValues.length > 0) {
      await upsertDeploymentEnvironmentVariables(tx, {
        userId: auth.userId,
        values: credentialValues,
      });
    }

    // Optional fields submitted as blank clear their previously saved value
    // (deployment-level rows only, mirroring how they are stored).
    const clearedPersistedEnvVarNames = clearedEnvVarNames.filter((name) =>
      persistedEnvVarNameSet.has(name),
    );

    if (clearedPersistedEnvVarNames.length > 0) {
      await tx
        .delete(environmentVariables)
        .where(
          and(
            isNull(environmentVariables.userId),
            inArray(environmentVariables.name, clearedPersistedEnvVarNames),
          ),
        );
    }

    const connectedProviderIds = new Set<string>([
      provider.id,
      ...collectConnectedTaskModelProviderIds({
        runtimeEnv: process.env,
        persistedEnvVarNames,
        chatgptConnected,
        xaiSubscriptionConnected,
      }),
    ]);
    const autoAdd = buildAutoAddedTaskModelSettings({
      provider,
      persistedTaskModelSettings: persistedTaskModels,
      connectedProviderIds,
    });

    addedRecommendedModelCount = autoAdd?.addedModels.length ?? 0;

    const setupNewState = normalizeSetupNewState({
      ...currentSetupNewState,
      modelProvider: provider.id,
      lastInteractedByUserId: auth.userId,
    });

    await tx
      .insert(deploymentSettings)
      .values({
        id: DEFAULT_DEPLOYMENT_ID,
        setupNewState,
        ...(autoAdd ? { taskModelSettings: autoAdd.taskModelSettings } : {}),
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          setupNewState,
          ...(autoAdd ? { taskModelSettings: autoAdd.taskModelSettings } : {}),
          updatedAt: new Date(),
        },
      });
  });

  let addedDiscoveredModelCount = 0;
  let discoveryError: string | null = null;

  if (provider.dynamicModels) {
    const discovery = await discoverProviderModelsCommand(auth, {
      provider: provider.id as LocalTaskModelProviderId,
    });
    discoveryError = discovery.error;

    if (!discovery.error && discovery.models.length > 0) {
      await db.transaction(async (tx) => {
        const persistedTaskModels = await getPersistedRawTaskModelSettings(tx);
        const currentSettings = normalizeTaskModelSettings(persistedTaskModels);
        const modelsById = new Map(
          (currentSettings.models ?? []).map((model) => [model.id, model]),
        );

        for (const model of discovery.models) {
          if (modelsById.has(model.modelId)) {
            continue;
          }

          modelsById.set(
            model.modelId,
            buildTaskModelOption({
              id: model.modelId,
              displayName: model.displayName ?? model.modelId,
              family: model.family ?? undefined,
              metadata: model.metadata,
            }),
          );
          addedDiscoveredModelCount += 1;
        }

        if (addedDiscoveredModelCount === 0) {
          return;
        }

        const models = [...modelsById.values()];
        await tx
          .insert(deploymentSettings)
          .values({
            id: DEFAULT_DEPLOYMENT_ID,
            taskModelSettings: normalizeTaskModelSettings({
              ...currentSettings,
              models,
              allowedModelIds: [
                ...new Set([
                  ...currentSettings.allowedModelIds,
                  ...discovery.models.map((model) => model.modelId),
                ]),
              ],
            }),
          })
          .onConflictDoUpdate({
            target: deploymentSettings.id,
            set: {
              taskModelSettings: normalizeTaskModelSettings({
                ...currentSettings,
                models,
                allowedModelIds: [
                  ...new Set([
                    ...currentSettings.allowedModelIds,
                    ...discovery.models.map((model) => model.modelId),
                  ]),
                ],
              }),
              updatedAt: new Date(),
            },
          });
      });
    }
  }

  return {
    ...(await getTaskModelProviderSetupCommand(auth)),
    addedRecommendedModelCount,
    addedDiscoveredModelCount,
    discoveryError,
  };
}

function getConnectedModelProviderCount(providerSetup: SetupModelStatus) {
  // A connected ChatGPT subscription is already represented by the `chatgpt`
  // catalog entry (`savedApiKeySatisfied` mirrors `chatgptConnected`), so the
  // filter below counts it; do not add it separately.
  return providerSetup.providers.filter(
    (provider) =>
      provider.runtimeApiKeySatisfied || provider.savedApiKeySatisfied,
  ).length;
}

function isModelIdForProvider(
  modelId: string,
  providerId: SetupModelProviderId,
) {
  return getTaskModelProviderId(modelId) === providerId;
}

function clearRuntimeModelForProvider(
  modelId: string | null,
  providerId: SetupModelProviderId,
) {
  return modelId && isModelIdForProvider(modelId, providerId) ? null : modelId;
}

function removeTaskModelsForProvider({
  settings,
  runtimeModelConfig,
  providerId,
}: {
  settings: ReturnType<typeof normalizeTaskModelSettings>;
  runtimeModelConfig: DeploymentModelConfig;
  providerId: SetupModelProviderId;
}) {
  const currentModels = settings.models ?? [];
  const models = currentModels.filter(
    (model) => !isModelIdForProvider(model.id, providerId),
  );
  const removedModelIds = new Set(
    currentModels
      .filter((model) => isModelIdForProvider(model.id, providerId))
      .map((model) => model.id),
  );

  const allowedModelIds = settings.allowedModelIds.filter(
    (modelId) => !removedModelIds.has(modelId),
  );

  const taskModelSettings = normalizeTaskModelSettings({
    models,
    allowedModelIds,
    defaultModelId: removedModelIds.has(settings.defaultModelId)
      ? (allowedModelIds[0] ?? models[0]?.id ?? '')
      : settings.defaultModelId,
  });

  const nextRuntimeModelConfig: DeploymentModelConfig = {
    ...runtimeModelConfig,
    roomoteModel: clearRuntimeModelForProvider(
      runtimeModelConfig.roomoteModel,
      providerId,
    ),
    roomoteSmallModel: clearRuntimeModelForProvider(
      runtimeModelConfig.roomoteSmallModel,
      providerId,
    ),
    roomoteVisionModel: clearRuntimeModelForProvider(
      runtimeModelConfig.roomoteVisionModel,
      providerId,
    ),
    roomoteCodeReviewModel: clearRuntimeModelForProvider(
      runtimeModelConfig.roomoteCodeReviewModel,
      providerId,
    ),
    roomoteExploreModel: clearRuntimeModelForProvider(
      runtimeModelConfig.roomoteExploreModel,
      providerId,
    ),
    roomotePlanningModel: clearRuntimeModelForProvider(
      runtimeModelConfig.roomotePlanningModel,
      providerId,
    ),
  };

  return { taskModelSettings, runtimeModelConfig: nextRuntimeModelConfig };
}

export async function deleteTaskModelProviderCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SetupModelProviderId;
  },
): Promise<{ providerSetup: SetupModelStatus }> {
  assertAdmin(auth);

  const provider = getSetupModelProvider(input.provider);

  if (provider.authKind === 'oauth') {
    throw new Error(
      `${provider.label} is connected with a subscription account and cannot be deleted here.`,
    );
  }

  await db.transaction(async (tx) => {
    const [
      persistedRuntimeModelConfig,
      persistedEnvVarNames,
      setupNewState,
      chatgptConnected,
      xaiSubscriptionConnected,
      persistedTaskModelSettings,
    ] = await Promise.all([
      getDeploymentRuntimeModelConfig(),
      getPersistedEnvironmentVariableNames(tx),
      getDeploymentSetupNewState(tx),
      isChatGptSubscriptionConnected(),
      isXaiSubscriptionConnected(),
      getDeploymentTaskModelSettings(),
    ]);

    const providerSetup = buildSetupModelStatus({
      runtimeEnv: process.env,
      persistedModelConfig: persistedRuntimeModelConfig,
      persistedEnvVarNames,
      selectedProvider: setupNewState.modelProvider,
      chatgptConnected,
      xaiSubscriptionConnected,
    });
    const providerStatus = providerSetup.providers.find(
      (candidate) => candidate.id === provider.id,
    );

    // xAI dual-path: API key and SuperGrok share the `xai` catalog id. When
    // deleting the key while a subscription remains, only strip env vars and
    // leave models/runtime intact.
    const xaiKeyOnlyDelete =
      provider.id === 'xai' &&
      xaiSubscriptionConnected &&
      Boolean(providerSetup.xaiApiKeyConnected);

    if (!providerStatus?.savedApiKeySatisfied) {
      throw new Error(`${provider.label} does not have saved credentials.`);
    }

    // Key-only xAI delete is allowed even when the catalog shows a single
    // connected `xai` entry, because the subscription remains as a provider.
    if (
      !xaiKeyOnlyDelete &&
      getConnectedModelProviderCount(providerSetup) <= 1
    ) {
      throw new Error('Keep at least one inference provider connected.');
    }

    const providerEnvVarNames = getSetupModelProviderEnvVarNames(provider);

    if (providerEnvVarNames.length > 0) {
      await tx
        .delete(environmentVariables)
        .where(
          and(
            isNull(environmentVariables.userId),
            inArray(environmentVariables.name, providerEnvVarNames),
          ),
        );
    }

    if (xaiKeyOnlyDelete) {
      // Subscription still covers xai/* models; do not cascade model removal.
      return;
    }

    const nextModelState = removeTaskModelsForProvider({
      settings: persistedTaskModelSettings,
      runtimeModelConfig: persistedRuntimeModelConfig,
      providerId: provider.id,
    });
    const nextSetupNewState = normalizeSetupNewState({
      ...setupNewState,
      modelProvider:
        setupNewState.modelProvider === provider.id
          ? null
          : setupNewState.modelProvider,
      lastInteractedByUserId: auth.userId,
    });

    await tx
      .insert(deploymentSettings)
      .values({
        id: DEFAULT_DEPLOYMENT_ID,
        taskModelSettings: nextModelState.taskModelSettings,
        runtimeModelConfig: nextModelState.runtimeModelConfig,
        setupNewState: nextSetupNewState,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          taskModelSettings: nextModelState.taskModelSettings,
          runtimeModelConfig: nextModelState.runtimeModelConfig,
          setupNewState: nextSetupNewState,
          updatedAt: new Date(),
        },
      });
  });

  return getTaskModelProviderSetupCommand(auth);
}

export async function getLaunchTaskModelsCommand(_auth: UserAuthSuccess) {
  const [
    settings,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
    persistedEnvVarNames,
  ] = await Promise.all([
    getDeploymentTaskModelSettings(),
    isChatGptSubscriptionConnected(),
    isGitHubCopilotSubscriptionConnected(),
    isXaiSubscriptionConnected(),
    getPersistedEnvironmentVariableNames(),
  ]);
  const providerSetup = buildSetupModelStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames,
    chatgptConnected,
    githubCopilotConnected,
    xaiSubscriptionConnected,
  });
  const isApiKeyProviderConnected = (providerId: SetupModelProviderId) =>
    Boolean(
      providerSetup.providers.find(
        (provider) =>
          provider.id === providerId &&
          (provider.savedApiKeySatisfied || provider.runtimeApiKeySatisfied),
      ),
    );
  const enabledModels = getEnabledTaskModels(settings);
  const defaultModel = getDefaultTaskModel(settings);

  return {
    defaultModelId: defaultModel.id,
    chatgptConnected,
    openaiConnected: isApiKeyProviderConnected('openai'),
    // Display-grouping inputs: `xai/` models group under the Grok
    // subscription only when the API-key sibling is not also connected.
    xaiSubscriptionConnected,
    xaiConnected: isApiKeyProviderConnected('xai'),
    models: enabledModels.map((option) => ({
      ...option,
      isDefault: option.id === defaultModel.id,
    })),
  };
}

export async function updateTaskModelSettingsCommand(
  auth: UserAuthSuccess,
  input: {
    models: Array<{
      id: string;
      displayName: string;
      family?: string;
      metadata?: TaskModelMetadata | null;
    }>;
    allowedModelIds: string[];
    defaultModelId: string;
    helperModelId: string | null;
    visionModelId: string | null;
    codeReviewModelId: string | null;
    exploreModelId?: string | null;
    planningModelId: string | null;
    codingModelReasoningEffort: ReasoningEffort | null;
    helperModelReasoningEffort: ReasoningEffort | null;
    visionModelReasoningEffort: ReasoningEffort | null;
    codeReviewModelReasoningEffort: ReasoningEffort | null;
    exploreModelReasoningEffort?: ReasoningEffort | null;
    planningModelReasoningEffort: ReasoningEffort | null;
  },
): Promise<
  | {
      success: true;
      settings: Awaited<ReturnType<typeof getTaskModelSettingsCommand>>;
    }
  | {
      success: false;
      fieldErrors: {
        models?: string;
        allowedModelIds?: string;
        defaultModelId?: string;
        helperModelId?: string;
        visionModelId?: string;
        codeReviewModelId?: string;
        exploreModelId?: string;
        planningModelId?: string;
      };
    }
> {
  assertAdmin(auth);

  const fieldErrors: {
    models?: string;
    allowedModelIds?: string;
    defaultModelId?: string;
    helperModelId?: string;
    visionModelId?: string;
    codeReviewModelId?: string;
    exploreModelId?: string;
    planningModelId?: string;
  } = {};
  const models = (() => {
    try {
      return input.models.map((model) => buildTaskModelOption(model));
    } catch {
      fieldErrors.models = 'Add valid models before saving.';
      return [];
    }
  })();
  const modelIds = models.map((model) => model.id);
  const knownModelIds = new Set<string>(modelIds);
  const allowedModelIds = [
    ...new Set(input.allowedModelIds.map(normalizeTaskModelId)),
  ].filter(Boolean);
  const normalizedDefaultModelId = normalizeTaskModelId(input.defaultModelId);
  const normalizedHelperModelId =
    input.helperModelId === null
      ? null
      : normalizeTaskModelId(input.helperModelId);
  const normalizedVisionModelId =
    input.visionModelId === null
      ? null
      : normalizeTaskModelId(input.visionModelId);
  const normalizedCodeReviewModelId =
    input.codeReviewModelId === null
      ? null
      : normalizeTaskModelId(input.codeReviewModelId);
  const normalizedExploreModelId =
    input.exploreModelId === undefined
      ? undefined
      : input.exploreModelId === null
        ? null
        : normalizeTaskModelId(input.exploreModelId);
  const normalizedExploreModelReasoningEffort =
    input.exploreModelReasoningEffort === undefined
      ? undefined
      : normalizeOptionalReasoningEffort(input.exploreModelReasoningEffort);
  const normalizedPlanningModelId =
    input.planningModelId === null
      ? null
      : normalizeTaskModelId(input.planningModelId);

  if (models.length === 0) {
    fieldErrors.models = 'Add at least one model.';
  } else if (new Set(modelIds).size !== modelIds.length) {
    fieldErrors.models = 'Each model slug must be unique.';
  }

  if (allowedModelIds.length === 0) {
    fieldErrors.allowedModelIds = 'Enable at least one model.';
  }

  if (allowedModelIds.some((modelId) => !knownModelIds.has(modelId))) {
    fieldErrors.allowedModelIds = 'One or more selected models are invalid.';
  }

  if (!knownModelIds.has(normalizedDefaultModelId)) {
    fieldErrors.defaultModelId = 'Choose a valid default model.';
  } else if (!allowedModelIds.includes(normalizedDefaultModelId)) {
    fieldErrors.defaultModelId = 'The default model must be enabled.';
  }

  if (
    normalizedHelperModelId !== null &&
    !knownModelIds.has(normalizedHelperModelId)
  ) {
    fieldErrors.helperModelId = 'Choose a valid helper model.';
  }

  if (
    normalizedVisionModelId !== null &&
    !knownModelIds.has(normalizedVisionModelId)
  ) {
    fieldErrors.visionModelId = 'Choose a valid vision model.';
  }

  if (
    normalizedCodeReviewModelId !== null &&
    !knownModelIds.has(normalizedCodeReviewModelId)
  ) {
    fieldErrors.codeReviewModelId = 'Choose a valid code review model.';
  }

  if (
    normalizedExploreModelId !== undefined &&
    normalizedExploreModelId !== null &&
    !knownModelIds.has(normalizedExploreModelId)
  ) {
    fieldErrors.exploreModelId = 'Choose a valid explore model.';
  }

  if (
    normalizedPlanningModelId !== null &&
    !knownModelIds.has(normalizedPlanningModelId)
  ) {
    fieldErrors.planningModelId = 'Choose a valid advisor model.';
  }

  const codingManagedByEnv = isConfiguredEnvValue(process.env.R_MODEL);
  const helperManagedByEnv = isConfiguredEnvValue(process.env.R_SMALL_MODEL);
  const visionManagedByEnv = isConfiguredEnvValue(process.env.R_VISION_MODEL);
  const codeReviewManagedByEnv = isConfiguredEnvValue(
    process.env.R_CODE_REVIEW_MODEL,
  );
  const exploreManagedByEnv = isConfiguredEnvValue(process.env.R_EXPLORE_MODEL);
  const planningManagedByEnv = isConfiguredEnvValue(
    process.env.R_PLANNING_MODEL,
  );
  const codingReasoningManagedByEnv =
    resolveEnvReasoningEffort('R_MODEL_REASONING_EFFORT') !== null;
  const helperReasoningManagedByEnv =
    resolveEnvReasoningEffort('R_SMALL_MODEL_REASONING_EFFORT') !== null;
  const visionReasoningManagedByEnv =
    resolveEnvReasoningEffort('R_VISION_MODEL_REASONING_EFFORT') !== null;
  const codeReviewReasoningManagedByEnv =
    resolveEnvReasoningEffort('R_CODE_REVIEW_MODEL_REASONING_EFFORT') !== null;
  const exploreReasoningManagedByEnv =
    resolveEnvReasoningEffort('R_EXPLORE_MODEL_REASONING_EFFORT') !== null;
  const planningReasoningManagedByEnv =
    resolveEnvReasoningEffort('R_PLANNING_MODEL_REASONING_EFFORT') !== null;

  if (Object.keys(fieldErrors).length > 0) {
    return {
      success: false,
      fieldErrors,
    };
  }

  const taskModelSettings = normalizeTaskModelSettings({
    models,
    allowedModelIds,
    defaultModelId: normalizedDefaultModelId,
  });

  const persistedRuntimeModelConfig = await getDeploymentRuntimeModelConfig();
  const nextRuntimeModelConfig: DeploymentModelConfig = {
    roomoteModel: codingManagedByEnv
      ? persistedRuntimeModelConfig.roomoteModel
      : normalizedDefaultModelId,
    roomoteSmallModel: helperManagedByEnv
      ? persistedRuntimeModelConfig.roomoteSmallModel
      : normalizedHelperModelId,
    roomoteVisionModel: visionManagedByEnv
      ? persistedRuntimeModelConfig.roomoteVisionModel
      : normalizedVisionModelId,
    roomoteCodeReviewModel: codeReviewManagedByEnv
      ? persistedRuntimeModelConfig.roomoteCodeReviewModel
      : normalizedCodeReviewModelId,
    roomoteExploreModel: exploreManagedByEnv
      ? persistedRuntimeModelConfig.roomoteExploreModel
      : normalizedExploreModelId === undefined
        ? persistedRuntimeModelConfig.roomoteExploreModel
        : normalizedExploreModelId,
    roomotePlanningModel: planningManagedByEnv
      ? persistedRuntimeModelConfig.roomotePlanningModel
      : normalizedPlanningModelId,
    roomoteModelReasoningEffort: codingReasoningManagedByEnv
      ? persistedRuntimeModelConfig.roomoteModelReasoningEffort
      : normalizeOptionalReasoningEffort(input.codingModelReasoningEffort),
    roomoteSmallModelReasoningEffort: helperReasoningManagedByEnv
      ? persistedRuntimeModelConfig.roomoteSmallModelReasoningEffort
      : normalizeOptionalReasoningEffort(input.helperModelReasoningEffort),
    roomoteVisionModelReasoningEffort: visionReasoningManagedByEnv
      ? persistedRuntimeModelConfig.roomoteVisionModelReasoningEffort
      : normalizeOptionalReasoningEffort(input.visionModelReasoningEffort),
    roomoteCodeReviewModelReasoningEffort: codeReviewReasoningManagedByEnv
      ? persistedRuntimeModelConfig.roomoteCodeReviewModelReasoningEffort
      : normalizeOptionalReasoningEffort(input.codeReviewModelReasoningEffort),
    roomoteExploreModelReasoningEffort: exploreReasoningManagedByEnv
      ? persistedRuntimeModelConfig.roomoteExploreModelReasoningEffort
      : normalizedExploreModelReasoningEffort === undefined
        ? persistedRuntimeModelConfig.roomoteExploreModelReasoningEffort
        : normalizedExploreModelReasoningEffort,
    roomotePlanningModelReasoningEffort: planningReasoningManagedByEnv
      ? persistedRuntimeModelConfig.roomotePlanningModelReasoningEffort
      : normalizeOptionalReasoningEffort(input.planningModelReasoningEffort),
  };

  await db
    .insert(deploymentSettings)
    .values({
      id: DEFAULT_DEPLOYMENT_ID,
      taskModelSettings,
      runtimeModelConfig: nextRuntimeModelConfig,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        taskModelSettings,
        runtimeModelConfig: nextRuntimeModelConfig,
        updatedAt: new Date(),
      },
    });

  return {
    success: true,
    settings: await getTaskModelSettingsCommand(auth),
  };
}

type OpenRouterModelLookupResponse = {
  data?: {
    id?: string;
    name?: string;
    context_length?: number;
    architecture?: {
      input_modalities?: string[];
    };
    pricing?: {
      prompt?: string;
      completion?: string;
    };
    supported_parameters?: string[];
  };
};

const OPENROUTER_MODALITY_ALIASES: Record<string, TaskModelInputType> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'sound',
  sound: 'sound',
  pdf: 'pdf',
  file: 'pdf',
};

function parseOpenRouterPrice(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

const OPENROUTER_INPUT_TYPE_ORDER: TaskModelInputType[] = [
  'text',
  'image',
  'video',
  'sound',
  'pdf',
];

function extractOpenRouterMetadata(
  payload: OpenRouterModelLookupResponse,
  refreshedAt: string,
): TaskModelMetadata | null {
  const data = payload.data;
  if (!data) {
    return null;
  }
  const contextWindow =
    typeof data.context_length === 'number' && data.context_length > 0
      ? data.context_length
      : null;
  const rawInputModalities = data.architecture?.input_modalities;
  const mappedModalities = rawInputModalities?.length
    ? new Set(
        rawInputModalities
          .map((m) => OPENROUTER_MODALITY_ALIASES[m.toLowerCase()])
          .filter((v): v is TaskModelInputType => Boolean(v)),
      )
    : null;
  const inputTypes = mappedModalities
    ? OPENROUTER_INPUT_TYPE_ORDER.filter((type) => mappedModalities.has(type))
    : null;
  const inputPricePerToken = parseOpenRouterPrice(data.pricing?.prompt);
  const outputPricePerToken = parseOpenRouterPrice(data.pricing?.completion);
  const supportsReasoning = Array.isArray(data.supported_parameters)
    ? data.supported_parameters.includes('reasoning')
    : null;
  if (
    contextWindow === null &&
    inputTypes === null &&
    inputPricePerToken === null &&
    outputPricePerToken === null &&
    supportsReasoning === null
  ) {
    return null;
  }
  return {
    contextWindow,
    inputTypes,
    inputPricePerToken,
    outputPricePerToken,
    lastRefreshedAt: refreshedAt,
    ...(supportsReasoning !== null ? { supportsReasoning } : {}),
  };
}

export async function discoverProviderModelsCommand(
  auth: UserAuthSuccess,
  input: { provider: LocalTaskModelProviderId } & LocalProviderConnectionInput,
) {
  assertAdmin(auth);
  return discoverProviderModels(input);
}

export async function qualifyProviderModelCommand(
  auth: UserAuthSuccess,
  input: {
    provider: LocalTaskModelProviderId;
    modelId: string;
  } & LocalProviderConnectionInput,
) {
  assertAdmin(auth);
  return qualifyProviderModel(input);
}

/**
 * Providers without a single-model lookup endpoint (Vercel AI Gateway and
 * direct labs such as Anthropic or OpenAI) resolve display name and pricing
 * from the models.dev catalog instead.
 */
async function lookupModelFromModelsDevCatalog(
  modelId: string,
): Promise<TaskModelLookupResult> {
  const catalog = await fetchModelsDevCatalog(
    AbortSignal.timeout(MODEL_METADATA_FETCH_TIMEOUT_MS),
  );

  if (!catalog) {
    return { modelId, displayName: null, family: null, metadata: null };
  }

  const lookup = lookupModelMetadataFromCatalog(catalog, modelId);
  const hasMetadata = Object.keys(lookup.metadata ?? {}).length > 0;
  const metadata = hasMetadata ? mergeMetadata(null, lookup.metadata) : null;

  if (metadata) {
    metadata.lastRefreshedAt = new Date().toISOString();
  }

  if (!lookup.displayName) {
    return { modelId, displayName: null, family: null, metadata };
  }

  const model = buildTaskModelOption({
    id: modelId,
    displayName: lookup.displayName,
    metadata,
  });

  return {
    modelId: model.id,
    displayName: model.displayName,
    family: model.family,
    metadata: model.metadata ?? null,
  };
}

export async function lookupTaskModelCommand(
  auth: UserAuthSuccess,
  input: { modelId: string },
): Promise<TaskModelLookupResult> {
  assertAdmin(auth);

  const modelId = normalizeTaskModelId(input.modelId);

  if (isTaskModelIdDisabled(modelId)) {
    throw new Error('This direct model provider is currently disabled.');
  }

  const existingCatalogModel =
    TASK_MODEL_CATALOG.find((option) => option.id === modelId) ?? null;

  if (existingCatalogModel) {
    const catalogModel = existingCatalogModel as TaskModelOption;
    return {
      modelId: catalogModel.id,
      displayName: catalogModel.displayName,
      family: catalogModel.family,
      metadata: catalogModel.metadata ?? null,
    };
  }

  const localProvider = getLocalTaskModelProviderIdFromModelId(modelId);
  if (localProvider) {
    const discovery = await discoverProviderModelsCommand(auth, {
      provider: localProvider,
    });
    const discoveredModel = discovery.models.find(
      (model) => model.modelId === modelId,
    );

    return (
      discoveredModel ?? {
        modelId,
        displayName: null,
        family: null,
        metadata: null,
      }
    );
  }

  // Only the OpenRouter model API supports single-model lookup; every other
  // provider (Vercel AI Gateway and direct labs such as Anthropic) resolves
  // from the models.dev catalog.
  if (!modelId.startsWith('openrouter/')) {
    return lookupModelFromModelsDevCatalog(modelId);
  }

  const runtimeOpenRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const openRouterKey = runtimeOpenRouterKey
    ? runtimeOpenRouterKey
    : (await getPersistedEnvironmentVariableValues(['OPENROUTER_API_KEY']))
        .OPENROUTER_API_KEY;

  if (!openRouterKey) {
    return {
      modelId,
      displayName: null,
      family: null,
      metadata: null,
    };
  }

  const openRouterModelSlug = modelId.slice('openrouter/'.length);
  const [openRouterAuthor, ...openRouterSlugParts] =
    openRouterModelSlug.split('/');
  const openRouterSlug = openRouterSlugParts.join('/');

  if (!openRouterAuthor || !openRouterSlug) {
    return {
      modelId,
      displayName: null,
      family: null,
      metadata: null,
    };
  }

  const lookupUrl = `https://openrouter.ai/api/v1/model/${encodeURIComponent(openRouterAuthor)}/${encodeURIComponent(openRouterSlug)}`;

  try {
    console.info('[lookupTaskModelCommand] Looking up model', {
      provider: 'openrouter',
      modelSlug: openRouterModelSlug,
      extractedProviderSlug: openRouterAuthor,
      extractedModelSlug: openRouterSlug,
      method: 'GET',
      url: lookupUrl,
    });

    const response = await fetch(lookupUrl, {
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
      },
      signal: AbortSignal.timeout(MODEL_METADATA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        modelId,
        displayName: null,
        family: null,
        metadata: null,
      };
    }

    const payload = (await response.json()) as OpenRouterModelLookupResponse;
    const displayName = payload.data?.name?.trim() || null;
    const metadata = extractOpenRouterMetadata(
      payload,
      new Date().toISOString(),
    );

    if (!displayName) {
      return {
        modelId,
        displayName: null,
        family: null,
        metadata,
      };
    }

    const model = buildTaskModelOption({
      id: modelId,
      displayName,
      metadata,
    });

    return {
      modelId: model.id,
      displayName: model.displayName,
      family: model.family,
      metadata: model.metadata ?? null,
    };
  } catch {
    return {
      modelId,
      displayName: null,
      family: null,
      metadata: null,
    };
  }
}

export async function suggestTaskModelsCommand(
  auth: UserAuthSuccess,
  input: { providerId: SetupModelProviderId; query: string },
): Promise<TaskModelSuggestionResult> {
  assertAdmin(auth);

  const provider = getSetupModelProvider(input.providerId);
  const query = input.query.trim();

  if (query.length < 1) {
    return { suggestions: [] };
  }

  const providerPrefix =
    provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID
      ? 'openai/'
      : `${provider.id}/`;
  const providerModelId = `${providerPrefix}${query}`;

  if (TASK_MODEL_CATALOG.some((model) => model.id === providerModelId)) {
    return { suggestions: [] };
  }

  const catalog = await fetchModelsDevCatalog(
    AbortSignal.timeout(MODEL_METADATA_FETCH_TIMEOUT_MS),
  );

  if (!catalog) {
    return { suggestions: [] };
  }

  const catalogProviderId =
    provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID ? 'openai' : provider.id;

  return {
    suggestions: suggestModelsFromCatalog({
      catalog,
      providerId: catalogProviderId,
      query,
      limit: 8,
    }),
  };
}

/**
 * Refreshes model metadata for all configured models in a single batched
 * models.dev fetch. Stamps `lastRefreshedAt` on success only. When the
 * deployment has no persisted models, seeds from the default catalog first.
 */
export async function refreshTaskModelMetadataCommand(
  auth: UserAuthSuccess,
): Promise<
  | { success: true; settings: TaskModelSettingsResult }
  | { success: false; error: string }
> {
  assertAdmin(auth);

  const [persistedSettings, persistedRuntimeModelConfig] = await Promise.all([
    getDeploymentTaskModelSettings(),
    getDeploymentRuntimeModelConfig(),
  ]);

  let currentModels: TaskModelOption[] = getTaskModelCatalog(persistedSettings);
  let allowedModelIds = persistedSettings.allowedModelIds;
  let defaultModelId = persistedSettings.defaultModelId;

  if (currentModels.length === 0) {
    currentModels = getTaskModelCatalog(null);
    allowedModelIds = [...currentModels.map((model) => model.id)];
    defaultModelId = currentModels[0]?.id ?? '';
  }

  if (currentModels.length === 0) {
    return { success: false, error: 'No models to refresh.' };
  }

  const catalog = await fetchModelsDevCatalog(
    AbortSignal.timeout(MODEL_METADATA_FETCH_TIMEOUT_MS),
    { forceRefresh: true },
  );
  if (!catalog) {
    return {
      success: false,
      error: 'Failed to fetch model metadata from models.dev.',
    };
  }

  const refreshedAt = new Date().toISOString();
  const refreshedModels: TaskModelOption[] = currentModels.map((model) => {
    const lookup = lookupModelMetadataFromCatalog(catalog, model.id);
    const hadMetadata = Object.keys(lookup.metadata ?? {}).length > 0;

    if (!hadMetadata) {
      return model;
    }

    const nextMetadata = mergeMetadata(model.metadata ?? null, lookup.metadata);
    nextMetadata.lastRefreshedAt = refreshedAt;
    return buildTaskModelOption({
      id: model.id,
      displayName: model.displayName,
      family: model.family,
      metadata: nextMetadata,
    });
  });

  const taskModelSettings = normalizeTaskModelSettings({
    models: refreshedModels,
    allowedModelIds,
    defaultModelId,
  });

  await db
    .insert(deploymentSettings)
    .values({
      id: DEFAULT_DEPLOYMENT_ID,
      taskModelSettings,
      runtimeModelConfig: persistedRuntimeModelConfig,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        taskModelSettings,
        updatedAt: new Date(),
      },
    });

  const settings = await getTaskModelSettingsCommand(auth);
  return { success: true, settings };
}
