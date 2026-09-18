import { eq, sql } from 'drizzle-orm';

import { DEFAULT_MARK_ROOMOTE_PR_READY_AFTER_CLEAN_REVIEW } from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const METADATA_KEY = 'mark_roomote_pr_ready_after_clean_review';

export async function getDeploymentMarkRoomotePrReadyAfterCleanReview(
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<boolean> {
  const executor = options.executor ?? db;
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  const metadata = deployment?.metadata as
    | Record<string, unknown>
    | null
    | undefined;
  const value = metadata?.[METADATA_KEY];

  return typeof value === 'boolean'
    ? value
    : DEFAULT_MARK_ROOMOTE_PR_READY_AFTER_CLEAN_REVIEW;
}

export async function setDeploymentMarkRoomotePrReadyAfterCleanReview(
  enabled: boolean,
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<boolean> {
  const executor = options.executor ?? db;

  await executor
    .update(deploymentSettings)
    .set({
      metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({
        [METADATA_KEY]: enabled,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));

  return enabled;
}
