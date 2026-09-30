import type { DiscordInteraction } from '@roomote/communication/discord-event';
import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import type { IntegrationToolApprovalDecision } from '@roomote/types';
import { findDiscordMappedUserId } from '@roomote/sdk/server';

import { decideCommunicationToolApproval } from '../tool-approval-action.js';
import { replyToDiscordEvent } from './replies.js';
import type { DiscordChannelContext } from './task-launch.js';

export async function handleDiscordToolApprovalAction(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  interaction: DiscordInteraction;
  interactionDeferred: boolean;
  channel: DiscordChannelContext;
  decision: IntegrationToolApprovalDecision;
}) {
  const user = input.interaction.member?.user ?? input.interaction.user;
  const userId = user?.id ? await findDiscordMappedUserId(user.id) : null;
  const accepted = await decideCommunicationToolApproval(
    userId,
    input.decision,
  );
  const resolution = accepted
    ? input.decision.decision === 'rejected'
      ? 'Tool call denied.'
      : 'Tool call allowed.'
    : 'This approval is unavailable or has already been handled.';
  if (
    accepted &&
    input.interaction.message?.id &&
    input.interaction.channel_id
  ) {
    // Provider presentation is best effort; the DB decision is already final.
    await input.provider
      .editMessage({
        channelId: input.interaction.channel_id,
        messageId: input.interaction.message.id,
        text: `${input.interaction.message.content ?? 'Tool approval'}\n\n${resolution}`,
      })
      .catch(() => undefined);
  }
  await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: input.channel,
    interaction: {
      interaction: input.interaction,
      interactionDeferred: input.interactionDeferred,
    },
    text: resolution,
  });
}
