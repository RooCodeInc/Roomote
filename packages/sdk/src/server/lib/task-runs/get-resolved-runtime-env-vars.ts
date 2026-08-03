import {
  resolveSourceControlProviderFromPayload,
  type AuthTokenContext,
  type RunTokenContext,
} from '@roomote/types';
import { db, eq, taskRuns } from '@roomote/db/server';

import {
  fetchResolvedRuntimeEnvVars,
  flattenResolvedRuntimeEnvVars,
} from './dequeue-helpers';

export async function getResolvedRuntimeEnvVars(
  _auth: AuthTokenContext | RunTokenContext,
  input: { runId: number; envContractVersion?: number },
) {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: { id: true, payload: true },
  });

  if (!taskRun) {
    throw new Error('Task run not found');
  }

  const resolvedEnv = await fetchResolvedRuntimeEnvVars(undefined, {
    sourceControlProvider: resolveSourceControlProviderFromPayload(
      taskRun.payload,
    ),
  });

  return input.envContractVersion === 2
    ? resolvedEnv
    : flattenResolvedRuntimeEnvVars(resolvedEnv);
}
