import { claimPendingPrReviewActionsForThread } from '@roomote/sdk/server';
import {
  buildResolvedSlackPrReviewMessageBlocks,
  type SlackNotifier,
} from '@roomote/slack';

import { apiLogger } from '../../logging.js';

type SlackPrReviewReplyContext = {
  slack: SlackNotifier;
  slackTeamId: string;
  channelId: string;
  threadTs: string;
};

async function claimAndRetireSlackPrReviewOffers({
  slack,
  slackTeamId,
  channelId,
  threadTs,
}: SlackPrReviewReplyContext) {
  const claimed = await claimPendingPrReviewActionsForThread({
    provider: 'slack',
    slackTeamId,
    channelId,
    threadId: threadTs,
  });

  void (async () => {
    for (const pending of claimed) {
      if (!pending.messageId) {
        continue;
      }

      const blocks = await slack.getMessageBlocks({
        channel: channelId,
        messageTs: pending.messageId,
        threadTs,
      });

      await slack.updateMessage({
        channel: channelId,
        ts: pending.messageId,
        message: {
          blocks: buildResolvedSlackPrReviewMessageBlocks(
            blocks,
            'Answered with a reply in the thread.',
          ),
        },
      });
    }
  })().catch((error: unknown) => {
    apiLogger.warn(
      `[SlackPrReviewRetire] Failed to retire offers for ${channelId}/${threadTs}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  return claimed;
}

/**
 * Claims pending review offers before a Fast turn so the completed child task
 * remains available as the target of an affirmative typed reply.
 */
export async function resolveFastAgentReplyTasks({
  activeTaskId,
  ...context
}: SlackPrReviewReplyContext & {
  activeTaskId?: string | null;
}): Promise<{ taskId: string }[]> {
  let claimedTaskIds: string[] = [];

  try {
    const claimed = await claimAndRetireSlackPrReviewOffers(context);
    claimedTaskIds = claimed.map((pending) => pending.taskId);
  } catch (error) {
    apiLogger.warn(
      `[SlackPrReviewRetire] Failed to claim offers for ${context.channelId}/${context.threadTs}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const taskIds = [activeTaskId, ...claimedTaskIds].filter(
    (taskId): taskId is string =>
      typeof taskId === 'string' && taskId.length > 0,
  );

  return [...new Set(taskIds)].map((taskId) => ({ taskId }));
}

/**
 * Retires any pending PR review offers bound to a Slack thread because a
 * typed reply superseded them: the person chose their own response, so the
 * buttons must die. Claims the offers atomically (later clicks report
 * "already handled") and rewrites each posted message without its buttons.
 * Fire-and-forget: retirement must never block or fail message delivery.
 */
export function retireSlackPrReviewOffersBestEffort({
  ...context
}: SlackPrReviewReplyContext): void {
  void resolveFastAgentReplyTasks(context);
}
