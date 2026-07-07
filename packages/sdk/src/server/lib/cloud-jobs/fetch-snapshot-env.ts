import {
  resolveSourceControlProviderFromPayload,
  type AuthTokenContext,
  type JobTokenContext,
  type SourceControlTokenMetadata,
} from '@roomote/types';
import { db, cloudJobs, eq } from '@roomote/db/server';

import {
  fetchEnvVars,
  createSourceControlTokenForJob,
} from './dequeue-helpers';

/**
 * Fetches environment variables and a source-control token for a snapshot job.
 * Used by the worker snapshot command to self-bootstrap its env, matching
 * the pattern used by dequeue and resume flows.
 */
export async function fetchSnapshotEnv(
  _auth: AuthTokenContext | JobTokenContext,
  input: { cloudJobId: number },
): Promise<{
  envVars: Record<string, string>;
  gitHubToken: string;
  sourceControlToken: SourceControlTokenMetadata;
  taskId: string;
}> {
  const tag = '[fetchSnapshotEnv]';
  const { cloudJobId } = input;

  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
  });

  if (!cloudJob) {
    throw new Error(`${tag} Cloud job not found: ${cloudJobId}`);
  }

  const envVars = await db.transaction(async (tx) => {
    return fetchEnvVars(tx, {
      sourceControlProvider: resolveSourceControlProviderFromPayload(
        cloudJob.payload,
      ),
    });
  });

  const sourceControlToken = await createSourceControlTokenForJob(
    cloudJob,
    tag,
  );

  if (!sourceControlToken) {
    throw new Error(
      `${tag} Failed to create source control token for cloud job ${cloudJobId}`,
    );
  }

  if (sourceControlToken.artifactsPatch) {
    const existingArtifacts =
      cloudJob.artifacts &&
      typeof cloudJob.artifacts === 'object' &&
      !Array.isArray(cloudJob.artifacts)
        ? (cloudJob.artifacts as Record<string, unknown>)
        : {};

    await db
      .update(cloudJobs)
      .set({
        artifacts: {
          ...existingArtifacts,
          ...sourceControlToken.artifactsPatch,
        },
      })
      .where(eq(cloudJobs.id, cloudJob.id));
  }

  const gitHubToken =
    sourceControlToken.provider === 'github' ? sourceControlToken.token : '';

  return { envVars, gitHubToken, sourceControlToken, taskId: cloudJob.taskId };
}
