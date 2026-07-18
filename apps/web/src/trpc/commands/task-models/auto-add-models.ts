import {
  SETUP_MODEL_PROVIDER_CATALOG,
  buildSetupModelStatus,
  buildTaskModelOption,
  getDefaultRecommendedModelPreset,
  getTaskModelCatalog,
  getTaskModelProviderId,
  normalizeTaskModelId,
  normalizeTaskModelSettings,
  taskModelSettingsSchema,
  type SetupModelProviderDescriptor,
  type SuggestedTaskModel,
  type TaskModelOption,
  type TaskModelSettings,
} from '@roomote/types';

function deriveDisplayNameFromModelId(modelId: string): string {
  return modelId.split('/').at(-1) || modelId;
}

/**
 * Model-id prefixes of the providers currently connected (saved or runtime
 * env). A connected ChatGPT subscription serves `openai/` model ids, so it
 * contributes `openai` alongside its own `chatgpt` catalog id.
 */
export function collectConnectedTaskModelProviderIds(options: {
  runtimeEnv: Partial<Record<string, string | undefined>>;
  persistedEnvVarNames: Iterable<string>;
  chatgptConnected: boolean;
  githubCopilotConnected?: boolean;
}): Set<string> {
  const status = buildSetupModelStatus({
    runtimeEnv: options.runtimeEnv,
    persistedEnvVarNames: options.persistedEnvVarNames,
    chatgptConnected: options.chatgptConnected,
    githubCopilotConnected: options.githubCopilotConnected,
  });

  return new Set([
    ...status.providers
      .filter(
        (provider) =>
          provider.runtimeApiKeySatisfied || provider.savedApiKeySatisfied,
      )
      .map((provider) => provider.id),
    ...(options.chatgptConnected ? ['openai'] : []),
  ]);
}

/**
 * Appends every connected provider's recommended models to the model
 * catalog, so the Available Models list always shows the full curated set
 * for connected providers. Appended entries carry no metadata (the refresh
 * action backfills it once they are persisted) and callers keep them
 * disabled until an operator enables them.
 */
export function appendRecommendedTaskModels(options: {
  models: readonly TaskModelOption[];
  connectedProviderIds: ReadonlySet<string>;
}): TaskModelOption[] {
  const modelIds = new Set(options.models.map((model) => model.id));
  const appendedModels: TaskModelOption[] = [];

  for (const provider of SETUP_MODEL_PROVIDER_CATALOG) {
    if (!options.connectedProviderIds.has(provider.id)) {
      continue;
    }

    for (const suggestion of provider.suggestedTaskModels) {
      const modelId = normalizeTaskModelId(suggestion.id);

      if (modelIds.has(modelId)) {
        continue;
      }

      const model = buildTaskModelOption({
        id: modelId,
        displayName: suggestion.displayName,
        family: suggestion.family,
        metadata: null,
      });

      modelIds.add(model.id);
      appendedModels.push(model);
    }
  }

  if (appendedModels.length === 0) {
    return [...options.models];
  }

  return [...options.models, ...appendedModels].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, {
      sensitivity: 'base',
      numeric: true,
    }),
  );
}

/**
 * Builds the task model settings to persist when an inference provider is
 * connected, auto-adding the provider's recommended models so the operator
 * lands on a usable model list instead of an empty one (or one holding only
 * another provider's models).
 *
 * Recommendations come from the provider's static curated list
 * (`suggestedTaskModels` in the setup provider catalog), so the seeded set
 * only changes with a release. The provider's `defaultRoomoteModel` is
 * always included so the setup wizard's runtime coding-model reset resolves
 * to a listed model. Models are added without metadata; the settings page's
 * metadata refresh action backfills context, pricing, and reasoning support.
 *
 * Returns null when nothing should change: the current model list already
 * has models for this provider (re-saving credentials must not resurrect
 * deliberately removed models), or every recommended model is already
 * present.
 */
export function buildAutoAddedTaskModelSettings(options: {
  provider: SetupModelProviderDescriptor;
  /** Raw `deployment_settings.task_model_settings` column value. */
  persistedTaskModelSettings: unknown;
  /**
   * Model-id prefixes of the providers currently connected (saved or runtime
   * env), including the provider being connected. When the deployment has
   * never persisted model settings, the implicit default catalog is filtered
   * to these providers so the seeded list only contains usable models.
   */
  connectedProviderIds: ReadonlySet<string>;
}): {
  taskModelSettings: TaskModelSettings;
  addedModels: TaskModelOption[];
} | null {
  // Endpoint-backed providers are populated by explicit discovery. Never seed
  // a guessed model id when the endpoint itself is the source of truth.
  if (options.provider.dynamicModels) {
    return null;
  }

  const parsed = taskModelSettingsSchema.safeParse(
    options.persistedTaskModelSettings,
  );
  const persisted = parsed.success ? parsed.data : null;
  const hasPersistedModels = (persisted?.models?.length ?? 0) > 0;

  const baseModels = hasPersistedModels
    ? getTaskModelCatalog(persisted)
    : getTaskModelCatalog(null).filter((model) => {
        const providerId = getTaskModelProviderId(model.id);
        return (
          providerId !== null && options.connectedProviderIds.has(providerId)
        );
      });

  if (
    baseModels.some(
      (model) => getTaskModelProviderId(model.id) === options.provider.id,
    )
  ) {
    return null;
  }

  const suggestions: readonly SuggestedTaskModel[] =
    options.provider.suggestedTaskModels;

  const defaultPreset = getDefaultRecommendedModelPreset(options.provider);
  const defaultPresetModels = Object.values(defaultPreset.roles);
  const providerDefaultModelId = normalizeTaskModelId(
    defaultPreset.roles.coding?.modelId ?? options.provider.defaultRoomoteModel,
  );
  const candidates: SuggestedTaskModel[] = [
    ...suggestions,
    ...defaultPresetModels.map((role) => ({
      id: role.modelId,
      displayName: role.displayName ?? '',
      family: role.family,
    })),
    ...(suggestions.some(
      (suggestion) =>
        normalizeTaskModelId(suggestion.id) === providerDefaultModelId,
    )
      ? []
      : [{ id: providerDefaultModelId, displayName: '' }]),
  ];

  const modelsById = new Map(baseModels.map((model) => [model.id, model]));
  const addedModels: TaskModelOption[] = [];

  for (const candidate of candidates) {
    const modelId = normalizeTaskModelId(candidate.id);

    if (modelsById.has(modelId)) {
      continue;
    }

    const model = buildTaskModelOption({
      id: modelId,
      displayName:
        candidate.displayName || deriveDisplayNameFromModelId(modelId),
      family: candidate.family,
    });

    modelsById.set(model.id, model);
    addedModels.push(model);
  }

  if (addedModels.length === 0) {
    return null;
  }

  const models = [...modelsById.values()];
  const allowedModelIds = [
    ...new Set([
      ...(hasPersistedModels
        ? persisted!.allowedModelIds.map(normalizeTaskModelId)
        : baseModels.map((model) => model.id)),
      ...addedModels.map((model) => model.id),
    ]),
  ];

  // Keep the effective default when it survives (it may drive the coding
  // model at runtime); otherwise prefer the connected provider's default.
  const currentDefaultModelId = normalizeTaskModelSettings(
    options.persistedTaskModelSettings,
  ).defaultModelId;
  const keepCurrentDefault =
    modelsById.has(currentDefaultModelId) &&
    allowedModelIds.includes(currentDefaultModelId);

  const taskModelSettings = normalizeTaskModelSettings({
    models,
    allowedModelIds,
    defaultModelId: keepCurrentDefault
      ? currentDefaultModelId
      : modelsById.has(providerDefaultModelId)
        ? providerDefaultModelId
        : addedModels[0]!.id,
  });

  return { taskModelSettings, addedModels };
}
