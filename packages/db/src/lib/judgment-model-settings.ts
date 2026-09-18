import { eq, sql } from 'drizzle-orm';

import {
  isJudgmentModelSelection,
  type JudgmentModelSelection,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const JUDGMENT_MODEL_METADATA_KEY = 'judgment_model';

/**
 * The judgment model an admin chose in Settings > Models, or null when none
 * was chosen (a TypeSafe key alone then selects Jev via TypeSafe).
 */
export async function getDeploymentJudgmentModelSelection(
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<JudgmentModelSelection | null> {
  const executor = options.executor ?? db;
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  const metadata = deployment?.metadata as
    | Record<string, unknown>
    | null
    | undefined;
  const value = metadata?.[JUDGMENT_MODEL_METADATA_KEY];

  return isJudgmentModelSelection(value) ? value : null;
}

export async function setDeploymentJudgmentModelSelection(
  selection: JudgmentModelSelection,
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<JudgmentModelSelection> {
  const executor = options.executor ?? db;
  const now = new Date();
  const patch = { [JUDGMENT_MODEL_METADATA_KEY]: selection };

  // Upsert: the default deployment row is not guaranteed to exist yet, and a
  // plain update would silently drop the admin's choice.
  await executor
    .insert(deploymentSettings)
    .values({ id: DEFAULT_DEPLOYMENT_ID, metadata: patch, updatedAt: now })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify(
          patch,
        )}::jsonb`,
        updatedAt: now,
      },
    });

  return selection;
}
