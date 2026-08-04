import { eq, sql } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const ACCOUNT_LINK_HELP_TEXT_METADATA_KEY = 'account_link_help_text';

export async function getDeploymentAccountLinkHelpText(
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<string | null> {
  const executor = options.executor ?? db;
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  const metadata = deployment?.metadata as
    | Record<string, unknown>
    | null
    | undefined;
  const value = metadata?.[ACCOUNT_LINK_HELP_TEXT_METADATA_KEY];

  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function setDeploymentAccountLinkHelpText(
  helpText: string | null,
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<string | null> {
  const executor = options.executor ?? db;
  const normalizedHelpText = helpText?.trim() || null;

  await executor
    .update(deploymentSettings)
    .set({
      metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({
        [ACCOUNT_LINK_HELP_TEXT_METADATA_KEY]: normalizedHelpText,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));

  return normalizedHelpText;
}
