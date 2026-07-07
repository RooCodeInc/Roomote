import { db, deploymentSettings, eq } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  FeatureFlag,
  FEATURE_FLAG_CONFIG,
  evaluateFeatureFlagFromMetadata,
  getFeatureFlagMetadataKey,
  type MetadataRecord,
} from '@roomote/feature-flags';
import { getFeatureFlagEvaluator } from '@roomote/feature-flags/server';

import type { UserAuthSuccess } from '@/types';

const DEFAULT_DEPLOYMENT_ID = 'default';

type DeploymentMetadataRecord = Record<string, unknown>;

export type ExperimentalFlag = {
  id: FeatureFlag;
  metadataKey: string;
  description: string;
  value: boolean;
  explicitlySet: boolean;
  defaultValue: boolean;
};

function normalizeMetadata(value: unknown): DeploymentMetadataRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...(value as DeploymentMetadataRecord) };
}

function resolveDefaultFlagValue(flag: FeatureFlag): boolean {
  const config = FEATURE_FLAG_CONFIG[flag];
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
    const config = FEATURE_FLAG_CONFIG[flag];
    const metadataKey = getFeatureFlagMetadataKey(flag);

    return {
      id: flag,
      metadataKey,
      description: config.description ?? '',
      value: evaluateFeatureFlagFromMetadata(flag, metadataRecord),
      explicitlySet: metadataKey in metadata,
      defaultValue: resolveDefaultFlagValue(flag),
    };
  });
}

async function getDeploymentMetadata(): Promise<DeploymentMetadataRecord> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      metadata: true,
    },
  });

  return normalizeMetadata(settings?.metadata);
}

function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

export async function getExperimentalFlagsCommand(
  auth: UserAuthSuccess,
): Promise<ExperimentalFlag[]> {
  assertAdmin(auth);

  const metadata = await getDeploymentMetadata();

  return buildExperimentalFlags(metadata);
}

export async function updateExperimentalFlagCommand(
  auth: UserAuthSuccess,
  input: { flag: FeatureFlag; value: boolean },
): Promise<ExperimentalFlag[]> {
  assertAdmin(auth);

  const metadataKey = getFeatureFlagMetadataKey(input.flag);

  if (!(input.flag in FEATURE_FLAG_CONFIG)) {
    throw new Error(`Unknown feature flag: ${input.flag}`);
  }

  const existingSettings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      metadata: true,
    },
  });

  const existingMetadata = normalizeMetadata(existingSettings?.metadata);
  const nextMetadata: DeploymentMetadataRecord = {
    ...existingMetadata,
    [metadataKey]: input.value,
  };

  const now = new Date();

  if (!existingSettings) {
    await db.insert(deploymentSettings).values({
      id: DEFAULT_DEPLOYMENT_ID,
      metadata: nextMetadata,
      setupCompletedAt: null,
    });
  } else {
    await db
      .update(deploymentSettings)
      .set({
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));
  }

  // Invalidate the Redis-cached deployment metadata so the worker/api SDK
  // evaluator picks up the new value on its next evaluation.
  await getFeatureFlagEvaluator(getRedis()).invalidateDeploymentCache();

  return buildExperimentalFlags(nextMetadata);
}
