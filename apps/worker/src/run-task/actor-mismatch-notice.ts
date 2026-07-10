import { replyToChatThread } from '../mcp/roomote-mcp-server/chat-api-client';
import { getRoomoteConfig } from '../mcp/roomote-mcp-server/config';

/**
 * User-facing notice posted to the task's chat thread when a queued message
 * is skipped because its sender is not the run's server-side acting user.
 * Resending re-enters the webhook's trusted pre-queue actor sync for that
 * sender, so the resent message runs under the sender's own identity.
 */
export const ACTOR_MISMATCH_SKIP_NOTICE_TEXT =
  'A queued message was skipped because this task is currently acting on ' +
  'behalf of a different user. If that was your message, please send it ' +
  'again to run it as yourself.';

export interface ActorMismatchSkipNoticeInput {
  senderUserId: string;
  serverActorUserId: string | null;
}

export type ActorMismatchSkipNotifier = (
  input: ActorMismatchSkipNoticeInput,
) => Promise<void>;

/**
 * Best-effort notifier for skipped mismatched messages. Posts one notice per
 * skipped sender per run to the task's bound chat thread (the
 * `/api/mcp/slack/thread_reply` endpoint routes Slack, Teams, and Telegram
 * tasks to their origin thread; tasks without a chat thread — e.g. Linear or
 * web-only — fail the post and only log). Never throws: skipping the message
 * is the security decision, the notice is UX.
 */
export function createActorMismatchSkipNotifier({
  runId,
  logger,
}: {
  runId: number;
  logger: {
    warn?: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}): ActorMismatchSkipNotifier {
  const notifiedSenderUserIds = new Set<string>();

  return async ({ senderUserId }) => {
    // One notice per sender per run: a multi-message batch from the same
    // sender should not spam the thread.
    if (notifiedSenderUserIds.has(senderUserId)) {
      return;
    }

    notifiedSenderUserIds.add(senderUserId);

    const warn = logger.warn ?? logger.error;

    try {
      const config = getRoomoteConfig();

      if (!config) {
        warn(
          `[actorMismatchNotice] Cannot post skip notice for run ${runId}: no cloud token available`,
        );
        return;
      }

      await replyToChatThread(config, {
        text: ACTOR_MISMATCH_SKIP_NOTICE_TEXT,
      });
    } catch (error) {
      warn(
        `[actorMismatchNotice] Failed to post skip notice for run ${runId} (sender ${senderUserId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}
