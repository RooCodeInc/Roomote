import { sdk } from '@roomote/sdk/client';

import { syncRuntimeGitAuthor } from '../lib/sync-runtime-git-author';
import type { RefreshActorScopedMcpResult } from './actor-scoped-mcp-refresh';
import type { ActorMismatchSkipNotifier } from './actor-mismatch-notice';

/**
 * How to treat a turn whose sender does not match the server-authoritative
 * acting user (no trusted server-side writer switched the run to them):
 *
 * - `block`: refuse the turn and keep it pending. Used by sandbox RPC
 *   surfaces (sendPrompt, steerTask, answerUserInputRequest) where the API
 *   performs a trusted pre-delivery actor sync — a mismatch there means that
 *   sync did not happen, and the caller gets a retryable error.
 * - `skip`: drop that message's CONTENT and post a best-effort notice to the
 *   task's chat thread asking the sender to resend. Used for queued/polled
 *   deliveries (Slack/Teams/Telegram/Linear polls, snapshot-resume replays,
 *   harness queued prompts) where blocking cannot converge: the server actor
 *   only moves via trusted writes, so a blocked queue would stall until the
 *   message TTL expires. Content is never executed under another identity's
 *   credential resolution — relabeling the turn's attribution would not
 *   change who authored the instructions, so a mismatched message must not
 *   run at all. A resend re-enters the webhook's trusted pre-queue actor
 *   sync for that sender and then delivers normally.
 */
export type ActorMismatchPolicy = 'block' | 'skip';

/**
 * Result of actor-scoped turn preparation:
 *
 * - `false`: the turn must not be delivered now (kept pending / retried).
 * - `{ skippedMismatch: true }`: the message's sender is not the server-side
 *   acting user under the `skip` policy — the caller must DROP this
 *   message's content (no requeue) and move on to the next one.
 * - `{ effectiveUserId }`: deliver. The identity the turn runs as; for
 *   non-empty senders this always equals both the requested sender and the
 *   server-authoritative acting user (mismatches never deliver).
 */
export type PrepareActorScopedTurnResult =
  | false
  | { skippedMismatch: true }
  | { skippedMismatch?: false; effectiveUserId: string | null };

interface PrepareActorScopedTurnOptions {
  runId?: number;
  targetUserId?: string;
  workingDirectory: string;
  logPrefix: string;
  allowMcpReconnect?: boolean;
  deferReconnectUntilTurnBoundary?: boolean;
  onMismatch?: ActorMismatchPolicy;
  getLastKnownActorUserId?: () => string | null;
  hasPendingGitAuthorSync?: () => boolean;
  onActorSynced?: (userId: string | null) => void;
  onGitAuthorSyncFailed?: () => void;
  /** Best-effort user-facing notice when a mismatched message is skipped. */
  notifyMismatchSkipped?: ActorMismatchSkipNotifier;
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
  runId?: number;
  targetUserId?: string;
  workingDirectory: string;
  logPrefix: string;
  onMismatch?: ActorMismatchPolicy;
  getLastKnownActorUserId?: () => string | null;
  hasPendingGitAuthorSync?: () => boolean;
  onActorSynced?: (userId: string | null) => void;
  onGitAuthorSyncFailed?: () => void;
  /** Best-effort user-facing notice when a mismatched message is skipped. */
  notifyMismatchSkipped?: ActorMismatchSkipNotifier;
  logger: {
    warn?: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

type SyncActorScopedTurnStateResult =
  | { ok: false }
  | { ok: true; skippedMismatch: true }
  | { ok: true; skippedMismatch?: false; effectiveUserId: string | null };

/**
 * Reconcile the worker's local actor state (git author, tracked actor) with
 * the server-authoritative `task_runs.actingUserId` ahead of a turn.
 *
 * The worker never writes the acting user — run tokens cannot reassign it
 * (see `syncActingUserId` in @roomote/sdk). This observes the server value
 * and follows it: when the server actor changed relative to the worker's
 * last-prepared one, the runtime git author is refreshed FROM the server
 * value, so commits after a trusted actor switch carry the new identity.
 *
 * Invariant enforced here: a message's content only ever runs when its
 * sender IS the server-side acting user. A mismatch either blocks the turn
 * (`block`) or drops that message's content with a user-facing notice
 * (`skip`) — it never delivers one user's instructions under another user's
 * credential resolution, no matter how the turn would be attributed.
 */
export async function syncActorScopedTurnState({
  runId,
  targetUserId,
  workingDirectory,
  logPrefix,
  onMismatch = 'block',
  getLastKnownActorUserId,
  hasPendingGitAuthorSync,
  onActorSynced,
  onGitAuthorSyncFailed,
  notifyMismatchSkipped,
  logger,
}: SyncActorScopedTurnStateOptions): Promise<SyncActorScopedTurnStateResult> {
  if (!runId || !targetUserId) {
    return { ok: false };
  }

  const lastKnownUserId = getLastKnownActorUserId?.();
  let outcome: Awaited<ReturnType<typeof sdk.taskRuns.syncActingUserId>>;

  try {
    outcome = await sdk.taskRuns.syncActingUserId({
      runId,
      newUserId: targetUserId,
      lastKnownUserId,
    });
  } catch (error) {
    logger.error(
      `${logPrefix} Failed to reconcile actingUserId for task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false };
  }

  if (outcome.result === 'not-found') {
    logger.error(
      `${logPrefix} Task run ${runId} was not found while reconciling actingUserId; skipping actor-scoped MCP refresh`,
    );
    return { ok: false };
  }

  if (outcome.result === 'mismatch') {
    const serverActorUserId = outcome.actingUserId ?? null;

    if (onMismatch === 'block') {
      logger.error(
        `${logPrefix} Blocking turn for task run ${runId}: sender ${targetUserId} is not the server-side acting user (${serverActorUserId ?? 'none'}) and no trusted writer switched the run to them`,
      );
      return { ok: false };
    }

    // `skip`: the sender's content must not run under the current actor's
    // credentials, and attributing it to the server actor would not change
    // who authored the instructions. Drop the content and tell the sender
    // to resend (a resend re-enters the trusted pre-queue actor sync).
    (logger.warn ?? logger.error)(
      `${logPrefix} Skipping message content for task run ${runId}: sender ${targetUserId} is not the server-side acting user (${serverActorUserId ?? 'none'}); asking the sender to resend`,
    );
    await notifyMismatchSkipped?.({
      senderUserId: targetUserId,
      serverActorUserId,
    });

    return { ok: true, skippedMismatch: true };
  }

  // `updated`/`unchanged` both mean the server actor IS the sender; the
  // turn runs as that single identity.
  const effectiveUserId = outcome.actingUserId ?? null;

  if (outcome.result === 'updated' || hasPendingGitAuthorSync?.()) {
    try {
      await syncRuntimeGitAuthor({
        runId,
        workingDirectory,
      });
      // Advance the last-prepared marker and clear any independent retry
      // state only after both git config writes land. The independent dirty
      // bit matters when a partial write fails during A -> B and the server
      // switches back to A before retry: actor equality alone would otherwise
      // suppress the repair and leave a mixed name/email configuration.
      onActorSynced?.(effectiveUserId);
    } catch (error) {
      onGitAuthorSyncFailed?.();
      logger.error(
        `${logPrefix} Failed to update git author for task run ${runId} (will retry on the next turn): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { ok: true, effectiveUserId };
}

export async function prepareActorScopedTurn({
  runId,
  targetUserId,
  workingDirectory,
  logPrefix,
  allowMcpReconnect = true,
  deferReconnectUntilTurnBoundary = false,
  onMismatch = 'block',
  getLastKnownActorUserId,
  hasPendingGitAuthorSync,
  onActorSynced,
  onGitAuthorSyncFailed,
  notifyMismatchSkipped,
  logger,
  refreshActorScopedIntegrations,
}: PrepareActorScopedTurnOptions): Promise<PrepareActorScopedTurnResult> {
  if (!runId || !targetUserId) {
    return { effectiveUserId: targetUserId ?? null };
  }

  logger.info?.(
    `${logPrefix} Preparing actor-scoped turn for task run ${runId}: targetUserId=${targetUserId} allowMcpReconnect=${allowMcpReconnect}`,
  );

  const syncResult = await syncActorScopedTurnState({
    runId,
    targetUserId,
    workingDirectory,
    logPrefix,
    onMismatch,
    getLastKnownActorUserId,
    hasPendingGitAuthorSync,
    onActorSynced,
    onGitAuthorSyncFailed,
    notifyMismatchSkipped,
    logger,
  });

  if (!syncResult.ok) {
    logger.info?.(
      `${logPrefix} Skipping actor-scoped MCP refresh because actor reconciliation blocked the turn for task run ${runId}`,
    );
    return false;
  }

  if (syncResult.skippedMismatch) {
    // No turn will run for this message; leave local actor state and MCP
    // mounts untouched.
    return { skippedMismatch: true };
  }

  const { effectiveUserId } = syncResult;

  if (!allowMcpReconnect) {
    logger.info?.(
      `${logPrefix} Deferring actor-scoped MCP refresh until the queued turn boundary for task run ${runId}`,
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
          `${logPrefix} Actor-scoped MCP refresh failed for task run ${runId}, but the mounted actor is unchanged; continuing with existing MCP state`,
        );
        return { effectiveUserId };
      }

      logger.info?.(
        `${logPrefix} Blocking actor-scoped turn delivery because MCP refresh failed for task run ${runId}`,
      );
      return false;
    }
  } catch (error) {
    logger.error(
      `${logPrefix} Failed to refresh actor-scoped MCP config for task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }

  return { effectiveUserId };
}
