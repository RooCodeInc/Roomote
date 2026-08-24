import type { FastAgentConversation } from '@roomote/types';

import {
  lookupCommunicationChannelMessages,
  lookupCommunicationMessageContext,
} from './mcp/communication-message-lookup';

export function createFastAgentChatContextAdapter(options: {
  actingUserId: string;
  conversation: FastAgentConversation;
}) {
  const slackTeamId =
    options.conversation.surface === 'slack'
      ? options.conversation.workspaceId
      : undefined;
  const channel =
    options.conversation.surface === 'discord'
      ? (options.conversation.replyTarget.threadId ??
        options.conversation.replyTarget.channelId)
      : options.conversation.replyTarget.channelId;

  return {
    getChatMessageContext: (input: {
      messageId?: string;
      messageLink?: string;
    }) =>
      lookupCommunicationMessageContext({
        actingUserId: options.actingUserId,
        provider: options.conversation.surface,
        ...(slackTeamId ? { slackTeamId } : {}),
        ...(input.messageLink
          ? { messageLink: input.messageLink }
          : { channel }),
        ...(input.messageId ? { messageId: input.messageId } : {}),
      }),
    getChatChannelMessages: (input: {
      channelLink?: string;
      oldest?: string;
      latest?: string;
    }) =>
      lookupCommunicationChannelMessages({
        actingUserId: options.actingUserId,
        provider: options.conversation.surface,
        ...(slackTeamId ? { slackTeamId } : {}),
        ...(input.channelLink
          ? { channelLink: input.channelLink }
          : { channel }),
        ...(input.oldest ? { oldest: input.oldest } : {}),
        ...(input.latest ? { latest: input.latest } : {}),
      }),
  };
}
