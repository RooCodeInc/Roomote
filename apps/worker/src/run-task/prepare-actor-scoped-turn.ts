import { sdk } from '@roomote/sdk/client';

import { syncRuntimeGitAuthor } from '../lib/sync-runtime-git-author';
import type { RefreshActorScopedMcpResult } from './actor-scoped-mcp-refresh';

interface PrepareActorScopedTurnOptions {
  cloudJobId?: number;
  targetUserId?: string;
  workingDirectory: string;
  logPrefix: string;
  allowMcpReconnect?: boolean;
  deferReconnectUntilTurnBoundary?: boolean;
  logger: {
    info?: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  refreshActorScopedIntegrations?: (
    targetUserId?: string,
    options?: {
      deferReconnectUntilTurnBoundary?: boolean;
    },
  ) => Promise<RefreshActorScopedMcpResult>;
}

interface SyncActorScopedTurnStateOptions {
  cloudJobId?: number;
  targetUserId?: string;
  workingDirectory: string;
  logPrefix: string;
  logger: {
    error: (...args: unknown[]) => void;
  };
}

export async function syncActorScopedTurnState({
  cloudJobId,
  targetUserId,
  workingDirectory,
  logPrefix,
  logger,
}: SyncActorScopedTurnStateOptions): Promise<boolean> {
  if (!cloudJobId || !targetUserId) {
    return false;
  }

  let syncResult: 'updated' | 'unchanged' | 'not-found';

  try {
    syncResult = await sdk.cloudJobs.syncActingUserId({
      cloudJobId,
      newUserId: targetUserId,
    });
  } catch (error) {
    logger.error(
      `${logPrefix} Failed to update actingUserId for cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }

  if (syncResult === 'not-found') {
    logger.error(
      `${logPrefix} Cloud job ${cloudJobId} was not found while updating actingUserId; skipping actor-scoped MCP refresh`,
    );
    return false;
  }

  if (syncResult === 'updated') {
    try {
      await syncRuntimeGitAuthor({
        cloudJobId,
        workingDirectory,
      });
    } catch (error) {
      logger.error(
        `${logPrefix} Failed to update git author for cloud job ${cloudJobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return true;
}

export async function prepareActorScopedTurn({
  cloudJobId,
  targetUserId,
  workingDirectory,
  logPrefix,
  allowMcpReconnect = true,
  deferReconnectUntilTurnBoundary = false,
  logger,
  refreshActorScopedIntegrations,
}: PrepareActorScopedTurnOptions): Promise<boolean> {
  if (!cloudJobId || !targetUserId) {
    return true;
  }

  logger.info?.(
    `${logPrefix} Preparing actor-scoped turn for cloud job ${cloudJobId}: targetUserId=${targetUserId} allowMcpReconnect=${allowMcpReconnect}`,
  );

  const didSyncActor = await syncActorScopedTurnState({
    cloudJobId,
    targetUserId,
    workingDirectory,
    logPrefix,
    logger,
  });

  if (!didSyncActor) {
    logger.info?.(
      `${logPrefix} Skipping actor-scoped MCP refresh because actingUserId was not updated for cloud job ${cloudJobId}`,
    );
    return false;
  }

  if (!allowMcpReconnect) {
    logger.info?.(
      `${logPrefix} Deferring actor-scoped MCP refresh until the queued turn boundary for cloud job ${cloudJobId}`,
    );
    return true;
  }

  try {
    const refreshResult = await refreshActorScopedIntegrations?.(targetUserId, {
      deferReconnectUntilTurnBoundary,
    });

    if (refreshResult?.didFail) {
      if (!refreshResult.actorChanged) {
        logger.info?.(
          `${logPrefix} Actor-scoped MCP refresh failed for cloud job ${cloudJobId}, but the mounted actor is unchanged; continuing with existing MCP state`,
        );
        return true;
      }

      logger.info?.(
        `${logPrefix} Blocking actor-scoped turn delivery because MCP refresh failed for cloud job ${cloudJobId}`,
      );
      return false;
    }
  } catch (error) {
    logger.error(
      `${logPrefix} Failed to refresh actor-scoped MCP config for cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }

  return true;
}
