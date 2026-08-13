import {
  db,
  deploymentSettings,
  eq,
  isXaiSubscriptionConnected,
} from '@roomote/db/server';
import {
  buildTaskModelOption,
  normalizeTaskModelId,
  normalizeTaskModelSettings,
} from '@roomote/types';

import { getPersistedEnvironmentVariableNames } from '../environment-variables';
import { collectConnectedTaskModelProviderIds } from './auto-add-models';
import {
  fetchModelsDevCatalog,
  listXaiChatModelsFromCatalog,
} from './models-dev';

const DEFAULT_DEPLOYMENT_ID = 'default';
const MODEL_METADATA_FETCH_TIMEOUT_MS = 10_000;

/**
 * Adds newly published Grok chat models to the deployment catalog and
 * enables them. Existing rows are left as-is so an operator who disabled a
 * model does not see it turned back on. No-ops when xAI is not connected or
 * the live catalog cannot be fetched.
 */
export async function syncConnectedXaiTaskModels(): Promise<number> {
  const [xaiSubscriptionConnected, persistedEnvVarNames] = await Promise.all([
    isXaiSubscriptionConnected(),
    getPersistedEnvironmentVariableNames(),
  ]);
  const connectedProviderIds = collectConnectedTaskModelProviderIds({
    runtimeEnv: process.env,
    persistedEnvVarNames,
    chatgptConnected: false,
    xaiSubscriptionConnected,
  });

  if (
    !connectedProviderIds.has('xai') &&
    !connectedProviderIds.has('xai-subscription')
  ) {
    return 0;
  }

  const catalog = await fetchModelsDevCatalog(
    AbortSignal.timeout(MODEL_METADATA_FETCH_TIMEOUT_MS),
  );

  if (!catalog) {
    return 0;
  }

  const xaiModels = listXaiChatModelsFromCatalog(catalog);

  if (xaiModels.length === 0) {
    return 0;
  }

  return db.transaction(async (tx) => {
    // Lock the row for this read-modify-write. launchOptions calls this on
    // page load; without the lock a concurrent Settings save can commit
    // between select and upsert and then get overwritten by this snapshot.
    const [persisted] = await tx
      .select({ taskModelSettings: deploymentSettings.taskModelSettings })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
      .limit(1)
      .for('update');
    const current = normalizeTaskModelSettings(
      persisted?.taskModelSettings ?? null,
    );
    const modelsById = new Map(
      (current.models ?? []).map((model) => [model.id, model]),
    );
    const addedIds: string[] = [];

    for (const model of xaiModels) {
      const modelId = normalizeTaskModelId(model.id);

      if (modelsById.has(modelId)) {
        continue;
      }

      modelsById.set(
        modelId,
        buildTaskModelOption({
          id: modelId,
          displayName: model.displayName,
          family: model.family,
        }),
      );
      addedIds.push(modelId);
    }

    if (addedIds.length === 0) {
      return 0;
    }

    const taskModelSettings = normalizeTaskModelSettings({
      ...current,
      models: [...modelsById.values()],
      allowedModelIds: [...new Set([...current.allowedModelIds, ...addedIds])],
    });

    await tx
      .insert(deploymentSettings)
      .values({
        id: DEFAULT_DEPLOYMENT_ID,
        taskModelSettings,
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          taskModelSettings,
          updatedAt: new Date(),
        },
      });

    return addedIds.length;
  });
}
