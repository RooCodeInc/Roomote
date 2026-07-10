import {
  resolveSourceControlProviderFromPayload,
  type AuthTokenContext,
  type RunTokenContext,
  type SourceControlTokenMetadata,
} from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';

import {
  fetchEnvVars,
  createSourceControlTokenForTaskRun,
} from './dequeue-helpers';

/**
 * Fetches environment variables and a source-control token for a snapshot job.
 * Used by the worker snapshot command to self-bootstrap its env, matching
 * the pattern used by dequeue and resume flows.
 */
export async function fetchSnapshotEnv(
  _auth: AuthTokenContext | RunTokenContext,
  input: { runId: number },
): Promise<{
  envVars: Record<string, string>;
  gitHubToken: string;
  sourceControlToken: SourceControlTokenMetadata;
  taskId: string;
}> {
  const tag = '[fetchSnapshotEnv]';
  const { runId } = input;

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun) {
    throw new Error(`${tag} Task run not found: ${runId}`);
  }

  const envVars = await db.transaction(async (tx) => {
    return fetchEnvVars(tx, {
      sourceControlProvider: resolveSourceControlProviderFromPayload(
        taskRun.payload,
      ),
    });
  });

  const sourceControlToken = await createSourceControlTokenForTaskRun(
    taskRun,
    tag,
  );

  if (!sourceControlToken) {
    throw new Error(
      `${tag} Failed to create source control token for task run ${runId}`,
    );
  }

  if (sourceControlToken.artifactsPatch) {
    const existingArtifacts =
      taskRun.artifacts &&
      typeof taskRun.artifacts === 'object' &&
      !Array.isArray(taskRun.artifacts)
        ? (taskRun.artifacts as Record<string, unknown>)
        : {};

    await db
      .update(taskRuns)
      .set({
        artifacts: {
          ...existingArtifacts,
          ...sourceControlToken.artifactsPatch,
        },
      })
      .where(eq(taskRuns.id, taskRun.id));
  }

  const gitHubToken =
    sourceControlToken.provider === 'github' ? sourceControlToken.token : '';

  return { envVars, gitHubToken, sourceControlToken, taskId: taskRun.taskId };
}
