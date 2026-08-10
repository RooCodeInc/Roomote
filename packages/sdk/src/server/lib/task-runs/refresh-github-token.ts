import type {
  AuthTokenContext,
  RunTokenContext,
  SourceControlProvider,
  SourceControlTokenEnvVar,
  SourceControlTokenMetadata,
} from '@roomote/types';
import { db, taskRuns, eq } from '@roomote/db/server';

import { createSourceControlTokenForTaskRun } from './dequeue-helpers';

const DEFAULT_SOURCE_CONTROL_TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000;
const SOURCE_CONTROL_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MIN_SOURCE_CONTROL_TOKEN_REFRESH_DELAY_MS = 60 * 1000;

/**
 * Generate a fresh source-control token for a task run within the caller's
 * scope. The exported name stays GitHub-specific for existing SDK callers.
 */
export async function refreshGitHubTokenWithMetadata(
  _auth: AuthTokenContext | RunTokenContext,
  runId: number,
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
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun) {
    throw new Error(`Task run not found: ${runId}`);
  }

  const tokenResult = await createSourceControlTokenForTaskRun(
    taskRun,
    '[refreshGitHubTokenWithMetadata]',
  );

  if (!tokenResult) {
    throw new Error(
      `Failed to refresh source control token for task run ${runId}`,
    );
  }

  if (tokenResult.artifactsPatch) {
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
          ...tokenResult.artifactsPatch,
        },
      })
      .where(eq(taskRuns.id, taskRun.id));
  }

  const now = Date.now();

  const nextRefreshAtMs = tokenResult.expiresAt
    ? Math.max(
        now + MIN_SOURCE_CONTROL_TOKEN_REFRESH_DELAY_MS,
        tokenResult.expiresAt.getTime() -
          SOURCE_CONTROL_TOKEN_REFRESH_BUFFER_MS,
      )
    : now + DEFAULT_SOURCE_CONTROL_TOKEN_REFRESH_INTERVAL_MS;

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
