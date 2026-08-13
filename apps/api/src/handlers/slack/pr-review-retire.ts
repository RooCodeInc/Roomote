import { claimPendingPrReviewActionsForThread } from '@roomote/sdk/server';
import {
  buildResolvedSlackPrReviewMessageBlocks,
  type SlackNotifier,
} from '@roomote/slack';

import { apiLogger } from '../../logging.js';

/**
 * Retires any pending PR review offers bound to a Slack thread because a
 * typed reply superseded them: the person chose their own response, so the
 * buttons must die. Claims the offers atomically (later clicks report
 * "already handled") and rewrites each posted message without its buttons.
 * Fire-and-forget: retirement must never block or fail message delivery.
 */
export function retireSlackPrReviewOffersBestEffort({
  slack,
  slackTeamId,
  channelId,
  threadTs,
}: {
  slack: SlackNotifier;
  slackTeamId: string;
  channelId: string;
  threadTs: string;
}): void {
  void (async () => {
    const claimed = await claimPendingPrReviewActionsForThread({
      provider: 'slack',
      slackTeamId,
      channelId,
      threadId: threadTs,
    });

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
}
