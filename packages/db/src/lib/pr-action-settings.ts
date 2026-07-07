import { eq, sql } from 'drizzle-orm';
import { normalizePrAction, type PrAction } from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const PR_ACTION_METADATA_KEY = 'pr_action';

/**
 * Deployment-wide default delivery mode for repository-changing tasks,
 * mirroring the upstream Coder agent `prAction` setting: 'draft' opens draft
 * PRs (default), 'create' opens ready-for-review PRs, 'push' pushes the
 * branch without opening a PR. Stored in deployment public metadata so no
 * migration is required.
 */
export async function getDeploymentPrAction(
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<PrAction> {
  const executor = options.executor ?? db;
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  const metadata = deployment?.metadata as
    | Record<string, unknown>
    | null
    | undefined;

  return normalizePrAction(metadata?.[PR_ACTION_METADATA_KEY]);
}

export async function setDeploymentPrAction(
  prAction: PrAction,
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<PrAction> {
  const executor = options.executor ?? db;
  const normalized = normalizePrAction(prAction);

  await executor
    .update(deploymentSettings)
    .set({
      metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({
        [PR_ACTION_METADATA_KEY]: normalized,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));

  return normalized;
}
