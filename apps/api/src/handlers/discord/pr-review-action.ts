import type { DiscordInteraction } from '@roomote/communication/discord-event';
import {
  DISCORD_MAX_MESSAGE_LENGTH,
  type DiscordCommunicationProvider,
} from '@roomote/communication/discord-provider';
import {
  claimPendingPrReviewAction,
  claimPendingPrReviewActionsForThread,
  dispatchPrReviewFollowUp,
  enableAutoHandlePrReviewFeedback,
  findDiscordMappedUserId,
} from '@roomote/sdk/server';
import type { PrReviewActionChoice } from '@roomote/types';

import { apiLogger } from '../../logging.js';
import { replyToDiscordEvent } from './replies.js';
import type { DiscordChannelContext } from './task-launch.js';

/**
 * Handles clicks on a PR review-feedback notification's Yes / auto-handle /
 * Dismiss buttons in Discord: claims the nonce-keyed pending offer and, on
 * acceptance, dispatches the prepared follow-up prompt into the owning task —
 * queued into the live run or waking the task from its snapshot.
 */
export async function handleDiscordPrReviewActionCallback(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
  channel: DiscordChannelContext;
  choice: PrReviewActionChoice;
  nonce: string;
}): Promise<void> {
  const reply = (text: string) =>
    replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      interaction: {
        interaction: input.interaction,
        interactionDeferred: input.interactionDeferred,
      },
      text,
    });
  const replyToOffer = (resolution: string) => {
    const content = input.interaction.message?.content;
    if (!content) return reply(resolution);

    const separator = '\n\n';
    const availableContentLength =
      DISCORD_MAX_MESSAGE_LENGTH - separator.length - resolution.length;
    const preservedContent =
      content.length <= availableContentLength
        ? content
        : availableContentLength > 3
          ? `${content.slice(0, availableContentLength - 3)}...`
          : content.slice(0, Math.max(availableContentLength, 0));

    return reply(`${preservedContent}${separator}${resolution}`);
  };
  const user = input.interaction.member?.user ?? input.interaction.user;
  const mappedUserId = await findDiscordMappedUserId(user?.id);

  if (input.choice !== 'dismiss' && !mappedUserId) {
    // Not claimed: a teammate with a linked account can still accept.
    await reply(
      'Link your Roomote account to start work from this notification.',
    );
    return;
  }

  const pending = await claimPendingPrReviewAction(input.nonce);

  if (!pending) {
    await replyToOffer('This offer was already handled or has expired.');
    return;
  }

  if (input.choice === 'dismiss') {
    await replyToOffer('Dismissed.');
    return;
  }

  try {
    if (input.choice === 'auto') {
      await enableAutoHandlePrReviewFeedback({
        taskId: pending.taskId,
        repository: pending.repository,
        prNumber: pending.prNumber,
        userId: mappedUserId!,
      });
    }

    const dispatched = await dispatchPrReviewFollowUp({
      provider: 'discord',
      channelId: pending.channelId,
      threadId: pending.threadId,
      followUpPrompt: pending.followUpPrompt,
      actingUserId: mappedUserId!,
      providerUserId: user?.id,
    });

    if (dispatched.outcome === 'unavailable') {
      await replyToOffer(
        input.choice === 'auto'
          ? "I'll resolve future feedback on this PR, but this task can no longer be resumed for the current feedback. Reply here to start fresh."
          : 'This task can no longer be resumed. Reply here to start fresh.',
      );
      return;
    }

    await replyToOffer(
      input.choice === 'auto'
        ? "I'll resolve these and any future feedback on this PR automatically. Starting on the current feedback now."
        : 'On it — resolving the review feedback.',
    );
  } catch (error) {
    apiLogger.error(
      `[discord] Failed to dispatch PR review follow-up for ${pending.repository}#${pending.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await replyToOffer(
      'Failed to start the follow-up. Reply here to ask again.',
    );
  }
}

/**
 * Retires any pending PR review offers bound to a Discord conversation
 * because a typed reply superseded them. Claims atomically so later clicks
 * report "already handled"; the buttons stay visible but dead (Discord
 * message component editing is not wired up yet). Fire-and-forget.
 */
export function retireDiscordPrReviewOffersBestEffort({
  channelId,
  threadId,
}: {
  channelId: string;
  threadId: string | null;
}): void {
  void (async () => {
    await claimPendingPrReviewActionsForThread({
      provider: 'discord',
      channelId,
      threadId,
    });
  })().catch((error: unknown) => {
    apiLogger.warn(
      `[discord] Failed to retire PR review offers for channel ${channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
