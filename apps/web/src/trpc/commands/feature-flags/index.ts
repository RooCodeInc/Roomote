import { db, deploymentSettings, eq } from '@roomote/db/server';
import {
  FeatureFlag,
  FEATURE_FLAG_CONFIG,
  evaluateFeatureFlagFromMetadata,
  getFeatureFlagMetadataKey,
  type MetadataRecord,
  type FeatureFlagConfig,
} from '@roomote/feature-flags';
import { getFeatureFlagEvaluator } from '@roomote/feature-flags/server';
import { getRedis } from '@roomote/redis';

import type { UserAuthSuccess } from '@/types';

const DEFAULT_DEPLOYMENT_ID = 'default';
type DeploymentMetadataRecord = Record<string, unknown>;

function getConfiguredFlag(flag: FeatureFlag): FeatureFlagConfig {
  const config = (
    FEATURE_FLAG_CONFIG as Partial<Record<string, FeatureFlagConfig>>
  )[flag];
  if (!config) throw new Error(`Unknown feature flag: ${String(flag)}`);
  return config;
}

export type ExperimentalFlag = {
  id: FeatureFlag;
  metadataKey: string;
  label: string | null;
  description: string;
  value: boolean;
  explicitlySet: boolean;
  defaultValue: boolean;
};

function normalizeMetadata(value: unknown): DeploymentMetadataRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as DeploymentMetadataRecord) };
}

async function getDeploymentMetadata(): Promise<DeploymentMetadataRecord> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  return normalizeMetadata(settings?.metadata);
}

function resolveDefaultFlagValue(flag: FeatureFlag): boolean {
  const config = getConfiguredFlag(flag);
  const defaultValue =
    typeof config.defaultValue === 'function'
      ? config.defaultValue()
      : config.defaultValue;
  return defaultValue === true;
}

function buildExperimentalFlags(
  metadata: DeploymentMetadataRecord,
): ExperimentalFlag[] {
  const metadataRecord = metadata as MetadataRecord;

  return (Object.values(FeatureFlag) as FeatureFlag[]).map((flag) => {
    const config = getConfiguredFlag(flag);
    const metadataKey = getFeatureFlagMetadataKey(flag);
    return {
      id: flag,
      metadataKey,
      label: config.label ?? null,
      description: config.description ?? '',
      value: evaluateFeatureFlagFromMetadata(flag, metadataRecord),
      explicitlySet: metadataKey in metadata,
      defaultValue: resolveDefaultFlagValue(flag),
    };
  });
}

function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) throw new Error('Unauthorized');
}

export async function getExperimentalFlagsCommand(
  auth: UserAuthSuccess,
): Promise<ExperimentalFlag[]> {
  assertAdmin(auth);
  if (Object.keys(FEATURE_FLAG_CONFIG).length === 0) return [];
  return buildExperimentalFlags(await getDeploymentMetadata());
}

export async function updateExperimentalFlagCommand(
  auth: UserAuthSuccess,
  input: { flag: FeatureFlag; value: boolean },
): Promise<ExperimentalFlag[]> {
  assertAdmin(auth);

  if (!Object.hasOwn(FEATURE_FLAG_CONFIG, input.flag)) {
    throw new Error(`Unknown feature flag: ${String(input.flag)}`);
  }

  const metadataKey = getFeatureFlagMetadataKey(input.flag);
  const existingSettings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  const existingMetadata = normalizeMetadata(existingSettings?.metadata);
  const nextMetadata = { ...existingMetadata, [metadataKey]: input.value };

  if (!existingSettings) {
    await db.insert(deploymentSettings).values({
      id: DEFAULT_DEPLOYMENT_ID,
      metadata: nextMetadata,
      setupCompletedAt: null,
    });
  } else {
    await db
      .update(deploymentSettings)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));
  }

  await getFeatureFlagEvaluator(getRedis()).invalidateDeploymentCache();
  return buildExperimentalFlags(nextMetadata);
}
