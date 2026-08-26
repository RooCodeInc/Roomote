import type { DiscordInteraction } from '@roomote/communication/discord-event';
import {
  DISCORD_MAX_MESSAGE_LENGTH,
  type DiscordCommunicationProvider,
} from '@roomote/communication/discord-provider';
import {
  claimPendingPrReviewAction,
  claimPendingPrReviewActionsForThread,
  completePendingPrReviewActionDispatch,
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
  const replyToOffer = (resolution: string, asSubtext = true) => {
    const formattedResolution = asSubtext ? `-# ${resolution}` : resolution;
    const content = input.interaction.message?.content;
    if (!content) return reply(formattedResolution);

    const separator = '\n\n';
    const availableContentLength =
      DISCORD_MAX_MESSAGE_LENGTH -
      separator.length -
      formattedResolution.length;
    const preservedContent =
      content.length <= availableContentLength
        ? content
        : availableContentLength > 3
          ? `${content.slice(0, availableContentLength - 3)}...`
          : content.slice(0, Math.max(availableContentLength, 0));

    return reply(`${preservedContent}${separator}${formattedResolution}`);
  };
  const user = input.interaction.member?.user ?? input.interaction.user;
  const mappedUserId = await findDiscordMappedUserId(user?.id);
  const clearOfferButtons = async (params: {
    channelId: string;
    messageId: string;
    text?: string;
  }) => {
    try {
      const text =
        params.text ??
        (
          await input.provider.getMessage({
            channelId: params.channelId,
            messageId: params.messageId,
          })
        )?.text;
      if (text === undefined) return;

      await input.provider.editMessage({
        channelId: params.channelId,
        messageId: params.messageId,
        text,
      });
    } catch (error) {
      apiLogger.warn(
        `[discord] Failed to clear PR review action buttons from ${params.messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  if (input.choice !== 'dismiss' && !mappedUserId) {
    // Not claimed: a teammate with a linked account can still accept.
    await reply(
      'Link your Roomote account to start work from this notification.',
    );
    return;
  }

  const pending = await claimPendingPrReviewAction(input.nonce, {
    choice: input.choice,
    actingUserId: mappedUserId ?? undefined,
  });

  if (!pending) {
    if (input.interaction.message) {
      await clearOfferButtons({
        channelId: input.interaction.message.channel_id,
        messageId: input.interaction.message.id,
        text: input.interaction.message.content,
      });
    }
    await replyToOffer('This offer was already handled or has expired.');
    return;
  }

  const offerMessageId = pending.messageId ?? input.interaction.message?.id;
  if (offerMessageId) {
    await clearOfferButtons({
      channelId: pending.threadId ?? pending.channelId,
      messageId: offerMessageId,
      ...(input.interaction.message
        ? { text: input.interaction.message.content }
        : {}),
    });
  }

  if (input.choice === 'dismiss') {
    await replyToOffer('Dismissed.');
    return;
  }

  try {
    if (input.choice === 'auto' && !pending.canonicalDeliveryId) {
      await enableAutoHandlePrReviewFeedback({
        taskId: pending.taskId,
        repository: pending.repository,
        prNumber: pending.prNumber,
        userId: mappedUserId!,
      });
    }

    const dispatched = await dispatchPrReviewFollowUp({
      provider: 'discord',
      taskId: pending.taskId,
      channelId: pending.channelId,
      threadId: pending.threadId,
      followUpPrompt: pending.followUpPrompt,
      actingUserId: mappedUserId!,
      providerUserId: user?.id,
      ...(pending.canonicalDeliveryId
        ? {
            idempotencyKey: `pr-review-delivery:${pending.canonicalDeliveryId}`,
          }
        : {}),
    });

    if (dispatched.outcome === 'unavailable') {
      await replyToOffer(
        input.choice === 'auto'
          ? "I'll resolve future feedback on this PR, but this task can no longer be resumed for the current feedback. Reply here to start fresh."
          : 'This task can no longer be resumed. Reply here to start fresh.',
      );
      return;
    }

    await completePendingPrReviewActionDispatch(pending, dispatched.runId);

    await replyToOffer(
      input.choice === 'auto'
        ? `OK, <@${user?.id}>. Future review feedback on this PR will get resolved automatically.`
        : 'On it — resolving the review feedback.',
      input.choice !== 'auto',
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
 * report "already handled" and strips the controls from posted messages.
 * Fire-and-forget.
 */
export function retireDiscordPrReviewOffersBestEffort({
  provider,
  channelId,
  threadId,
}: {
  provider: DiscordCommunicationProvider;
  channelId: string;
  threadId: string | null;
}): void {
  void (async () => {
    const claimed = await claimPendingPrReviewActionsForThread({
      provider: 'discord',
      channelId,
      threadId,
    });
    for (const pending of claimed) {
      if (!pending.messageId) continue;
      const destinationId = pending.threadId ?? pending.channelId;
      const message = await provider.getMessage({
        channelId: destinationId,
        messageId: pending.messageId,
      });
      if (message) {
        await provider.editMessage({
          channelId: destinationId,
          messageId: pending.messageId,
          text: message.text,
        });
      }
    }
  })().catch((error: unknown) => {
    apiLogger.warn(
      `[discord] Failed to retire PR review offers for channel ${channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
