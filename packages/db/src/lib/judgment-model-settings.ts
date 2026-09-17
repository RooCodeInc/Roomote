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

  await executor
    .update(deploymentSettings)
    .set({
      metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({
        [JUDGMENT_MODEL_METADATA_KEY]: selection,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));

  return selection;
}
