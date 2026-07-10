import {
  resolveSourceControlProviderFromPayload,
  type AuthTokenContext,
  type JobTokenContext,
} from '@roomote/types';
import { db, eq, taskRuns } from '@roomote/db/server';

import { fetchResolvedRuntimeEnvVars } from './dequeue-helpers';

export async function getResolvedRuntimeEnvVars(
  _auth: AuthTokenContext | JobTokenContext,
  input: { cloudJobId: number },
) {
  const cloudJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.cloudJobId),
    columns: { id: true, payload: true },
  });

  if (!cloudJob) {
    throw new Error('Cloud job not found');
  }

  return fetchResolvedRuntimeEnvVars(undefined, {
    sourceControlProvider: resolveSourceControlProviderFromPayload(
      cloudJob.payload,
    ),
  });
}
