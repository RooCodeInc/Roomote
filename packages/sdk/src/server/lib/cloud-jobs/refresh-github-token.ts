import type {
  AuthTokenContext,
  JobTokenContext,
  SourceControlProvider,
  SourceControlTokenEnvVar,
  SourceControlTokenMetadata,
} from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';

import { createSourceControlTokenForJob } from './dequeue-helpers';

const DEFAULT_GITHUB_TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000;
const USER_GITHUB_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MIN_GITHUB_TOKEN_REFRESH_DELAY_MS = 60 * 1000;

/**
 * Generate a fresh source-control token for a cloud job within the caller's
 * scope. The exported name stays GitHub-specific for existing SDK callers.
 */
export async function refreshGitHubTokenWithMetadata(
  _auth: AuthTokenContext | JobTokenContext,
  cloudJobId: number,
): Promise<{
  token: string;
  provider: SourceControlProvider;
  envVar: SourceControlTokenEnvVar;
  envVars: Partial<Record<SourceControlTokenEnvVar, string>>;
  gitCredentials?: SourceControlTokenMetadata['gitCredentials'];
  gitProxyCredentials?: SourceControlTokenMetadata['gitProxyCredentials'];
  source: 'user' | 'app';
  expiresAt: string | null;
  nextRefreshAt: string;
}> {
  const cloudJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, cloudJobId),
  });

  if (!cloudJob) {
    throw new Error(`Cloud job not found: ${cloudJobId}`);
  }

  const tokenResult = await createSourceControlTokenForJob(
    cloudJob,
    '[refreshGitHubTokenWithMetadata]',
  );

  if (!tokenResult) {
    throw new Error(
      `Failed to refresh source control token for cloud job ${cloudJobId}`,
    );
  }

  if (tokenResult.artifactsPatch) {
    const existingArtifacts =
      cloudJob.artifacts &&
      typeof cloudJob.artifacts === 'object' &&
      !Array.isArray(cloudJob.artifacts)
        ? (cloudJob.artifacts as Record<string, unknown>)
        : {};

    await db
      .update(taskRuns)
      .set({
        artifacts: {
          ...existingArtifacts,
          ...tokenResult.artifactsPatch,
        },
      })
      .where(eq(taskRuns.id, cloudJob.id));
  }

  const now = Date.now();

  const nextRefreshAtMs =
    tokenResult.source === 'user' && tokenResult.expiresAt
      ? Math.max(
          now + MIN_GITHUB_TOKEN_REFRESH_DELAY_MS,
          tokenResult.expiresAt.getTime() - USER_GITHUB_TOKEN_REFRESH_BUFFER_MS,
        )
      : now + DEFAULT_GITHUB_TOKEN_REFRESH_INTERVAL_MS;

  return {
    token: tokenResult.token,
    provider: tokenResult.provider,
    envVar: tokenResult.envVar,
    envVars: tokenResult.envVars,
    gitCredentials: tokenResult.gitCredentials,
    gitProxyCredentials: tokenResult.gitProxyCredentials,
    source: tokenResult.source,
    expiresAt: tokenResult.expiresAt?.toISOString() ?? null,
    nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
  };
}
