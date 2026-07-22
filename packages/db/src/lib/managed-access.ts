import {
  MANAGED_ACCESS_METADATA_KEY,
  type ManagedDeploymentAccess,
  getManagedDeploymentAccessFromMetadata,
} from '@roomote/types';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export class StaleManagedAccessDecisionError extends Error {
  readonly currentAccess: ManagedDeploymentAccess;

  constructor(currentAccess: ManagedDeploymentAccess) {
    super('Managed access decision is stale or conflicts with current state.');
    this.name = 'StaleManagedAccessDecisionError';
    this.currentAccess = currentAccess;
  }
}

export async function readManagedDeploymentAccess(): Promise<ManagedDeploymentAccess> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  return getManagedDeploymentAccessFromMetadata(deployment?.metadata);
}

export async function applyManagedDeploymentAccessDecision(
  nextAccess: ManagedDeploymentAccess,
): Promise<ManagedDeploymentAccess> {
  return db.transaction(async (tx) => {
    const [lockedSettings] = await tx.execute<{
      metadata: unknown;
    }>(sql`
      SELECT metadata
      FROM deployment_settings
      WHERE id = ${DEFAULT_DEPLOYMENT_ID}
      FOR UPDATE
    `);

    const metadata = normalizeMetadata(lockedSettings?.metadata);
    const currentAccess = getManagedDeploymentAccessFromMetadata(metadata);

    if (nextAccess.revision < currentAccess.revision) {
      throw new StaleManagedAccessDecisionError(currentAccess);
    }

    if (nextAccess.revision === currentAccess.revision) {
      if (JSON.stringify(nextAccess) !== JSON.stringify(currentAccess)) {
        throw new StaleManagedAccessDecisionError(currentAccess);
      }

      return currentAccess;
    }

    const nextMetadata = {
      ...metadata,
      [MANAGED_ACCESS_METADATA_KEY]: nextAccess,
    };

    if (lockedSettings) {
      await tx
        .update(deploymentSettings)
        .set({ metadata: nextMetadata })
        .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));
    } else {
      await tx.insert(deploymentSettings).values({
        id: DEFAULT_DEPLOYMENT_ID,
        metadata: nextMetadata,
      });
    }

    return nextAccess;
  });
}
