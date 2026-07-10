import { sdk } from '@roomote/sdk/client';

import { syncRuntimeGitAuthor } from '../lib/sync-runtime-git-author';
import type { RefreshActorScopedMcpResult } from './actor-scoped-mcp-refresh';

/**
 * How to treat a turn whose sender does not match the server-authoritative
 * acting user (no trusted server-side writer switched the run to them):
 *
 * - `block`: refuse the turn. Used by sandbox RPC surfaces (sendPrompt,
 *   steerTask, answerUserInputRequest) where the API performs a trusted
 *   pre-delivery actor sync — a mismatch there means that sync did not
 *   happen, and the caller gets a retryable error.
 * - `follow-server`: run the turn as the server actor instead of the
 *   sender. Used for queued/polled deliveries (Slack/Teams/Telegram/Linear
 *   polls, snapshot-resume replays) where requeueing cannot converge — the
 *   server value only moves via trusted writes, so a blocked queue would
 *   stall until the message TTL expires. Credential resolution is always
 *   server-side, so this keeps the turn's attribution aligned with the
 *   credentials that actor-scoped routes will actually resolve.
 */
export type ActorMismatchPolicy = 'block' | 'follow-server';

/**
 * Result of actor-scoped turn preparation. `false` means the turn must not
 * be delivered. Otherwise `effectiveUserId` is the identity the turn runs
 * as — always the server-authoritative acting user (which equals the
 * requested sender except under a `follow-server` mismatch).
 */
export type PrepareActorScopedTurnResult =
  | false
  | { effectiveUserId: string | null };

interface PrepareActorScopedTurnOptions {
  cloudJobId?: number;
  targetUserId?: string;
  workingDirectory: string;
  logPrefix: string;
  allowMcpReconnect?: boolean;
  deferReconnectUntilTurnBoundary?: boolean;
  onMismatch?: ActorMismatchPolicy;
  getLastKnownActorUserId?: () => string | null;
  onActorSynced?: (userId: string | null) => void;
  logger: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
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
  onMismatch?: ActorMismatchPolicy;
  getLastKnownActorUserId?: () => string | null;
  onActorSynced?: (userId: string | null) => void;
  logger: {
    warn?: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

type SyncActorScopedTurnStateResult =
  | { ok: false }
  | { ok: true; effectiveUserId: string | null };

/**
 * Reconcile the worker's local actor state (git author, tracked actor) with
 * the server-authoritative `task_runs.actingUserId` ahead of a turn.
 *
 * The worker never writes the acting user — job tokens cannot reassign it
 * (see `syncActingUserId` in @roomote/sdk). This observes the server value
 * and follows it: when the server actor changed relative to the worker's
 * last-prepared one, the runtime git author is refreshed FROM the server
 * value, so commits after a trusted actor switch carry the new identity.
 */
export async function syncActorScopedTurnState({
  cloudJobId,
  targetUserId,
  workingDirectory,
  logPrefix,
  onMismatch = 'block',
  getLastKnownActorUserId,
  onActorSynced,
  logger,
}: SyncActorScopedTurnStateOptions): Promise<SyncActorScopedTurnStateResult> {
  if (!cloudJobId || !targetUserId) {
    return { ok: false };
  }

  const lastKnownUserId = getLastKnownActorUserId?.();
  let outcome: Awaited<ReturnType<typeof sdk.cloudJobs.syncActingUserId>>;

  try {
    outcome = await sdk.cloudJobs.syncActingUserId({
      cloudJobId,
      newUserId: targetUserId,
      lastKnownUserId,
    });
  } catch (error) {
    logger.error(
      `${logPrefix} Failed to reconcile actingUserId for cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false };
  }

  if (outcome.result === 'not-found') {
    logger.error(
      `${logPrefix} Cloud job ${cloudJobId} was not found while reconciling actingUserId; skipping actor-scoped MCP refresh`,
    );
    return { ok: false };
  }

  if (outcome.result === 'mismatch' && onMismatch === 'block') {
    logger.error(
      `${logPrefix} Blocking turn for cloud job ${cloudJobId}: sender ${targetUserId} is not the server-side acting user (${outcome.actingUserId ?? 'none'}) and no trusted writer switched the run to them`,
    );
    return { ok: false };
  }

  // Server-authoritative identity the turn will run as. Under a
  // follow-server mismatch this is the server actor, not the sender.
  const effectiveUserId = outcome.actingUserId ?? null;

  if (outcome.result === 'mismatch') {
    (logger.warn ?? logger.error)(
      `${logPrefix} Delivering turn for cloud job ${cloudJobId} as server actor ${effectiveUserId ?? 'none'} instead of sender ${targetUserId}: no trusted writer switched the run to the sender`,
    );
  }

  const actorChanged =
    outcome.result === 'updated' ||
    (outcome.result === 'mismatch' && effectiveUserId !== lastKnownUserId);

  if (actorChanged) {
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

    onActorSynced?.(effectiveUserId);
  }

  return { ok: true, effectiveUserId };
}

export async function prepareActorScopedTurn({
  cloudJobId,
  targetUserId,
  workingDirectory,
  logPrefix,
  allowMcpReconnect = true,
  deferReconnectUntilTurnBoundary = false,
  onMismatch = 'block',
  getLastKnownActorUserId,
  onActorSynced,
  logger,
  refreshActorScopedIntegrations,
}: PrepareActorScopedTurnOptions): Promise<PrepareActorScopedTurnResult> {
  if (!cloudJobId || !targetUserId) {
    return { effectiveUserId: targetUserId ?? null };
  }

  logger.info?.(
    `${logPrefix} Preparing actor-scoped turn for cloud job ${cloudJobId}: targetUserId=${targetUserId} allowMcpReconnect=${allowMcpReconnect}`,
  );

  const syncResult = await syncActorScopedTurnState({
    cloudJobId,
    targetUserId,
    workingDirectory,
    logPrefix,
    onMismatch,
    getLastKnownActorUserId,
    onActorSynced,
    logger,
  });

  if (!syncResult.ok) {
    logger.info?.(
      `${logPrefix} Skipping actor-scoped MCP refresh because actor reconciliation blocked the turn for cloud job ${cloudJobId}`,
    );
    return false;
  }

  const { effectiveUserId } = syncResult;

  if (!allowMcpReconnect) {
    logger.info?.(
      `${logPrefix} Deferring actor-scoped MCP refresh until the queued turn boundary for cloud job ${cloudJobId}`,
    );
    return { effectiveUserId };
  }

  try {
    const refreshResult = await refreshActorScopedIntegrations?.(
      effectiveUserId ?? undefined,
      {
        deferReconnectUntilTurnBoundary,
      },
    );

    if (refreshResult?.didFail) {
      if (!refreshResult.actorChanged) {
        logger.info?.(
          `${logPrefix} Actor-scoped MCP refresh failed for cloud job ${cloudJobId}, but the mounted actor is unchanged; continuing with existing MCP state`,
        );
        return { effectiveUserId };
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

  return { effectiveUserId };
}
