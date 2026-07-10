import { and, db, eq, isNull, ne, or, taskRuns } from '@roomote/db/server';

import { logHandlerError } from '../utils';

/**
 * Trusted server-side writers for `task_runs.actingUserId`.
 *
 * `actingUserId` feeds actor-scoped credential resolution
 * (resolveActorScopedUserContext -> userApiKeys / mcpConnections and the MCP
 * proxy's resolveActingUserId), so it must only ever be written by the server
 * from identities it resolved itself (an authenticated web user, or a chat
 * sender mapped to a Roomote user by the webhook handler). Run-scoped job
 * tokens cannot write it — `cloudJobs.update` strips the field — and the
 * worker only observes the value.
 *
 * The write must land BEFORE the message is delivered to (or picked up by)
 * the sandbox: the worker refuses to run a turn whose sender does not match
 * the server-side acting user (or falls back to the server actor for queued
 * replays), so a late write would block or mis-attribute the turn.
 */
export async function updateActingUserIdIfNeeded({
  jobId,
  currentActingUserId,
  nextActingUserId,
  preserveActor,
}: {
  jobId: number;
  currentActingUserId: string | null;
  nextActingUserId: string;
  preserveActor: boolean;
}): Promise<void> {
  if (preserveActor || currentActingUserId === nextActingUserId) {
    return;
  }

  await db
    .update(taskRuns)
    .set({ actingUserId: nextActingUserId })
    .where(eq(taskRuns.id, jobId));
}

/**
 * Pre-queue trusted actor sync for inbound chat messages that the worker
 * polls (Slack/Teams/Telegram/Linear active-job queues).
 *
 * Called by webhook handlers with the sender they resolved to a Roomote user.
 * Skips unmapped senders (`senderUserId` undefined/null): those messages run
 * under the run's current actor, matching the previous worker behavior.
 *
 * Non-fatal by design: queueing the message matters more than switching the
 * actor. If this write fails, the worker detects the mismatch at delivery
 * time and runs the turn under the server-side actor instead of the sender —
 * degraded attribution, never a credential mix-up.
 */
export async function syncActingUserForInboundMessage({
  logContext,
  jobId,
  senderUserId,
}: {
  logContext: string;
  jobId: number;
  senderUserId: string | null | undefined;
}): Promise<void> {
  if (!senderUserId) {
    return;
  }

  try {
    await db
      .update(taskRuns)
      .set({ actingUserId: senderUserId })
      .where(
        and(
          eq(taskRuns.id, jobId),
          or(
            isNull(taskRuns.actingUserId),
            ne(taskRuns.actingUserId, senderUserId),
          ),
        ),
      );
  } catch (error) {
    logHandlerError(
      logContext,
      `Non-fatal actingUserId sync failure for cloud job ${jobId} ` +
        `(next=${senderUserId}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
