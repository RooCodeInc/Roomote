import { db, deploymentSettings, eq } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  ANONYMOUS_ANALYTICS_METADATA_KEY,
  isAnonymousAnalyticsEnabledFromMetadata,
} from '@roomote/feature-flags';
import { getFeatureFlagEvaluator } from '@roomote/feature-flags/server';
import { isTelemetryEnvAllowed } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

const DEFAULT_DEPLOYMENT_ID = 'default';

export type MiscSettings = {
  /** The admin-controlled opt-out setting (default: enabled). */
  anonymousAnalyticsEnabled: boolean;
  /**
   * Whether this environment can send telemetry at all. False in
   * development or when no release version is baked in; the setting is
   * still editable so it applies once the deployment runs a real release.
   */
  telemetryEnvAllowed: boolean;
};

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

async function readDeploymentMetadata(): Promise<Record<string, unknown>> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  return normalizeMetadata(settings?.metadata);
}

export async function getMiscSettingsCommand(
  auth: UserAuthSuccess,
): Promise<MiscSettings> {
  assertAdmin(auth);

  const metadata = await readDeploymentMetadata();

  return {
    anonymousAnalyticsEnabled:
      isAnonymousAnalyticsEnabledFromMetadata(metadata),
    telemetryEnvAllowed: isTelemetryEnvAllowed(),
  };
}

export async function setAnonymousAnalyticsCommand(
  auth: UserAuthSuccess,
  input: { enabled: boolean },
): Promise<MiscSettings> {
  assertAdmin(auth);

  const existingSettings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  const nextMetadata: Record<string, unknown> = {
    ...normalizeMetadata(existingSettings?.metadata),
    [ANONYMOUS_ANALYTICS_METADATA_KEY]: input.enabled,
  };

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

  // Keep the Redis-cached deployment metadata coherent for any evaluator
  // consumers, mirroring the experimental feature-flag update path.
  await getFeatureFlagEvaluator(getRedis()).invalidateDeploymentCache();

  return {
    anonymousAnalyticsEnabled:
      isAnonymousAnalyticsEnabledFromMetadata(nextMetadata),
    telemetryEnvAllowed: isTelemetryEnvAllowed(),
  };
}
