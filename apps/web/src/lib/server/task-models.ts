import { db, deploymentSettings, eq } from '@roomote/db/server';
import {
  type DeploymentModelConfig,
  getTaskModelDisplayName,
  normalizeDeploymentModelConfig,
  normalizeTaskModelSettings,
  taskModelSettingsSchema,
} from '@roomote/types';
import type { TaskModelSettings } from '@roomote/types';

const DEFAULT_DEPLOYMENT_ID = 'default';

export async function getDeploymentTaskModelSettings() {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      taskModelSettings: true,
    },
  });

  return normalizeTaskModelSettings(deployment?.taskModelSettings);
}

/**
 * Returns model settings only when an operator has actually persisted a
 * valid catalog. Callers that need to distinguish the implicit default
 * OpenRouter catalog from saved choices should use this instead of the
 * normalized fallback above.
 */
export async function getPersistedDeploymentTaskModelSettings(): Promise<TaskModelSettings | null> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      taskModelSettings: true,
    },
  });
  const parsed = taskModelSettingsSchema.safeParse(
    deployment?.taskModelSettings,
  );

  return parsed.success ? parsed.data : null;
}

export async function getDeploymentRuntimeModelConfig(): Promise<DeploymentModelConfig> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      runtimeModelConfig: true,
    },
  });

  return normalizeDeploymentModelConfig(deployment?.runtimeModelConfig);
}

export async function getTaskModelDisplayNameMap(
  modelIds: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const uniqueModelIds = [
    ...new Set([...modelIds].filter(Boolean)),
  ] as string[];

  if (uniqueModelIds.length === 0) {
    return new Map();
  }

  const settings = await getDeploymentTaskModelSettings();

  return new Map(
    uniqueModelIds.map((modelId) => [
      modelId,
      getTaskModelDisplayName(modelId, settings),
    ]),
  );
}
