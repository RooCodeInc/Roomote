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
  type TaskModelOption,
} from '@roomote/types';

import { getPersistedEnvironmentVariableNames } from '../environment-variables';
import { collectConnectedTaskModelProviderIds } from './auto-add-models';
import {
  fetchModelsDevCatalog,
  listXaiChatModelsFromCatalog,
} from './models-dev';

const DEFAULT_DEPLOYMENT_ID = 'default';
// Shorter than the Settings metadata-refresh timeout: this fetch sits on the
// launch-options page load, so a slow models.dev must not stall it for long.
const XAI_SYNC_CATALOG_FETCH_TIMEOUT_MS = 3_000;

/** True when the xAI API key or the Grok subscription is connected. */
export async function isXaiTaskProviderConnected(): Promise<boolean> {
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

  return (
    connectedProviderIds.has('xai') ||
    connectedProviderIds.has('xai-subscription')
  );
}

/**
 * Diffs the live Grok chat catalog against a persisted model list. The very
 * first sync only records the current catalog as a baseline
 * (`catalogSyncedModelIds`): connecting xAI must seed the recommended models,
 * not flood the list with the whole Grok back-catalog. Later syncs add only
 * models published after that baseline. Every catalog id stays recorded, so
 * a model the operator deletes is never re-added.
 */
export function collectXaiCatalogModelUpdates(options: {
  xaiModels: ReadonlyArray<{
    id: string;
    displayName: string;
    family: string;
  }>;
  models: readonly TaskModelOption[];
  syncedModelIds: readonly string[] | undefined;
}): {
  addedModels: TaskModelOption[];
  syncedModelIds: string[];
  changed: boolean;
} {
  const existingModelIds = new Set(options.models.map((model) => model.id));
  // An empty baseline is treated as never-recorded, the same as
  // normalizeTaskModelSettings: real baselines are always non-empty, and an
  // empty one must not authorize adding the whole back-catalog.
  const previouslySyncedIds =
    options.syncedModelIds === undefined || options.syncedModelIds.length === 0
      ? null
      : new Set(options.syncedModelIds.map(normalizeTaskModelId));
  const syncedIds = new Set(previouslySyncedIds ?? []);
  const addedModels: TaskModelOption[] = [];

  for (const model of options.xaiModels) {
    const modelId = normalizeTaskModelId(model.id);
    syncedIds.add(modelId);

    if (
      previouslySyncedIds === null ||
      existingModelIds.has(modelId) ||
      previouslySyncedIds.has(modelId)
    ) {
      continue;
    }

    existingModelIds.add(modelId);
    addedModels.push(
      buildTaskModelOption({
        id: modelId,
        displayName: model.displayName,
        family: model.family,
      }),
    );
  }

  return {
    addedModels,
    syncedModelIds: [...syncedIds],
    changed:
      addedModels.length > 0 ||
      syncedIds.size !== (previouslySyncedIds?.size ?? 0),
  };
}

/**
 * Adds Grok chat models published after the deployment's sync baseline to
 * the catalog and enables them, so a new Grok release reaches the task
 * switcher without an admin visit. The first sync only records the baseline
 * (the back-catalog is not pulled in); models the operator disabled stay
 * disabled, and models the operator deleted stay deleted
 * (`catalogSyncedModelIds` remembers every id the catalog has offered).
 * No-ops when xAI is not connected, the live catalog cannot be fetched, or
 * the deployment has never persisted model settings — the raw null value is
 * the "still on implicit defaults" sentinel and seeding is the
 * provider-connect flow's job. Never throws: callers include the
 * launch-options page load and the OAuth connect flow, which must not fail
 * because this opportunistic sync did.
 */
export async function syncConnectedXaiTaskModels(): Promise<number> {
  try {
    if (!(await isXaiTaskProviderConnected())) {
      return 0;
    }

    const catalog = await fetchModelsDevCatalog(
      AbortSignal.timeout(XAI_SYNC_CATALOG_FETCH_TIMEOUT_MS),
    );

    if (!catalog) {
      return 0;
    }

    const xaiModels = listXaiChatModelsFromCatalog(catalog);

    if (xaiModels.length === 0) {
      return 0;
    }

    // Unlocked pre-check so the steady state (nothing new in the catalog)
    // never takes the row lock that Settings saves contend on.
    const [preview] = await db
      .select({ taskModelSettings: deploymentSettings.taskModelSettings })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
      .limit(1);

    if (preview?.taskModelSettings == null) {
      return 0;
    }

    const previewSettings = normalizeTaskModelSettings(
      preview.taskModelSettings,
    );

    if (
      !collectXaiCatalogModelUpdates({
        xaiModels,
        models: previewSettings.models ?? [],
        syncedModelIds: previewSettings.catalogSyncedModelIds,
      }).changed
    ) {
      return 0;
    }

    return await db.transaction(async (tx) => {
      // Re-read under a row lock for the read-modify-write: without it a
      // concurrent Settings save can commit between select and update and
      // then get overwritten by this snapshot.
      const [persisted] = await tx
        .select({ taskModelSettings: deploymentSettings.taskModelSettings })
        .from(deploymentSettings)
        .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
        .limit(1)
        .for('update');

      if (persisted?.taskModelSettings == null) {
        return 0;
      }

      const current = normalizeTaskModelSettings(persisted.taskModelSettings);
      const updates = collectXaiCatalogModelUpdates({
        xaiModels,
        models: current.models ?? [],
        syncedModelIds: current.catalogSyncedModelIds,
      });

      if (!updates.changed) {
        return 0;
      }

      const taskModelSettings = normalizeTaskModelSettings({
        ...current,
        models: [...(current.models ?? []), ...updates.addedModels],
        allowedModelIds: [
          ...new Set([
            ...current.allowedModelIds,
            ...updates.addedModels.map((model) => model.id),
          ]),
        ],
        catalogSyncedModelIds: updates.syncedModelIds,
      });

      await tx
        .update(deploymentSettings)
        .set({
          taskModelSettings,
          updatedAt: new Date(),
        })
        .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));

      return updates.addedModels.length;
    });
  } catch (error) {
    console.error('Failed to sync Grok chat models from the live catalog:', {
      error,
    });
    return 0;
  }
}
