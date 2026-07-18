import { buildAccountLinkThreadReplyText } from '@roomote/communication/chat-messages';
import type { DiscordInteraction } from '@roomote/communication/discord-event';
import {
  DiscordApiError,
  type DiscordCommunicationProvider,
} from '@roomote/communication/discord-provider';

import { apiLogger } from '../../logging.js';
import { replyToDiscordEvent } from './replies.js';
import type { DiscordChannelContext } from './task-launch.js';

const DISCORD_LINK_REQUIRED_MESSAGE =
  'Link your Discord account to Roomote before starting tasks. Generate a code under **Settings → Personal → Linked Accounts**, then DM me with `/link code:<code>`.';
const DISCORD_ACCOUNT_LABEL = 'Discord account';
const DISCORD_ACCOUNT_LINK_FALLBACK_INSTRUCTION =
  'Generate a code under **Settings → Personal → Linked Accounts**, then DM me with `/link code:<code>`.';

function isDmBlockedError(error: unknown): boolean {
  return (
    error instanceof DiscordApiError &&
    (error.code === 50007 || error.code === '50007' || error.status === 403)
  );
}

/**
 * Prefer a DM for the full link prompt (same as channel auto-start and Slack/
 * Teams): public channels only get a short ack so we do not clutter them with
 * setup instructions. When DMs are blocked, the short public reply carries the
 * full instruction instead.
 */
export async function promptDiscordAccountLink(input: {
  provider: DiscordCommunicationProvider;
  applicationId: string;
  channel: DiscordChannelContext;
  discordUserId: string;
  interaction?: {
    interaction: DiscordInteraction;
    interactionDeferred: boolean;
  };
  replyToMessageId?: string;
}): Promise<void> {
  if (input.channel.isDirectMessage) {
    await replyToDiscordEvent({
      provider: input.provider,
      applicationId: input.applicationId,
      channel: input.channel,
      ...(input.interaction ? { interaction: input.interaction } : {}),
      text: DISCORD_LINK_REQUIRED_MESSAGE,
      ...(input.replyToMessageId
        ? { replyToMessageId: input.replyToMessageId }
        : {}),
    });
    return;
  }

  let dmPromptSent = false;
  try {
    const dmChannel = await input.provider.createDirectMessage(
      input.discordUserId,
    );
    await input.provider.postMessage({
      channelId: dmChannel.id,
      text: DISCORD_LINK_REQUIRED_MESSAGE,
    });
    dmPromptSent = true;
  } catch (error) {
    if (isDmBlockedError(error)) {
      apiLogger.info(
        `[discord] Could not DM link prompt to ${input.discordUserId} (DMs blocked)`,
      );
    } else {
      apiLogger.warn(
        `[discord] Failed to DM link prompt to ${input.discordUserId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await replyToDiscordEvent({
    provider: input.provider,
    applicationId: input.applicationId,
    channel: input.channel,
    ...(input.interaction ? { interaction: input.interaction } : {}),
    text: buildAccountLinkThreadReplyText({
      dmPromptSent,
      accountLabel: DISCORD_ACCOUNT_LABEL,
      fallbackInstruction: DISCORD_ACCOUNT_LINK_FALLBACK_INSTRUCTION,
    }),
    ...(input.replyToMessageId
      ? { replyToMessageId: input.replyToMessageId }
      : {}),
  });
}
