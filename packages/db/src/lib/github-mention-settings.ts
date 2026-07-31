import { eq, sql } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const GITHUB_ROOMOTE_MENTION_METADATA_KEY = 'github_roomote_mention_enabled';

export async function getDeploymentGitHubRoomoteMentionEnabled(
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
  const value = metadata?.[GITHUB_ROOMOTE_MENTION_METADATA_KEY];

  return typeof value === 'boolean' ? value : true;
}

export async function setDeploymentGitHubRoomoteMentionEnabled(
  enabled: boolean,
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<boolean> {
  const executor = options.executor ?? db;

  await executor
    .update(deploymentSettings)
    .set({
      metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({
        [GITHUB_ROOMOTE_MENTION_METADATA_KEY]: enabled,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));

  return enabled;
}
