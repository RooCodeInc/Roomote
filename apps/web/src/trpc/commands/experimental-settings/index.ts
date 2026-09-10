import { db, deploymentSettings, eq } from '@roomote/db/server';
import {
  isOpenCodeCodeModeEnabledFromMetadata,
  OPENCODE_CODE_MODE_METADATA_KEY,
} from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

const DEFAULT_DEPLOYMENT_ID = 'default';

export type ExperimentalSettings = {
  openCodeCodeModeEnabled: boolean;
};

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export async function getExperimentalSettingsCommand(
  auth: UserAuthSuccess,
): Promise<ExperimentalSettings> {
  assertAdmin(auth);
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  return {
    openCodeCodeModeEnabled: isOpenCodeCodeModeEnabledFromMetadata(
      settings?.metadata,
    ),
  };
}

export async function setOpenCodeCodeModeCommand(
  auth: UserAuthSuccess,
  input: { enabled: boolean },
): Promise<ExperimentalSettings> {
  assertAdmin(auth);
  const existing = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  const metadata = {
    ...normalizeMetadata(existing?.metadata),
    [OPENCODE_CODE_MODE_METADATA_KEY]: input.enabled,
  };
  const now = new Date();

  await db
    .insert(deploymentSettings)
    .values({ id: DEFAULT_DEPLOYMENT_ID, metadata, updatedAt: now })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: { metadata, updatedAt: now },
    });

  return { openCodeCodeModeEnabled: input.enabled };
}
