import type { FastAgentConversation } from '@roomote/types';

import {
  lookupCommunicationChannelMessages,
  lookupCommunicationMessageContext,
} from './mcp/communication-message-lookup';

export function createFastAgentChatContextAdapter(options: {
  actingUserId: string;
  conversation: FastAgentConversation;
}) {
  const channel =
    options.conversation.surface === 'discord'
      ? (options.conversation.replyTarget.threadId ??
        options.conversation.replyTarget.channelId)
      : options.conversation.replyTarget.channelId;

  return {
    getChatMessageContext: (input: { messageId: string }) =>
      lookupCommunicationMessageContext({
        actingUserId: options.actingUserId,
        channel,
        messageId: input.messageId,
        provider: options.conversation.surface,
      }),
    getChatChannelMessages: (input: { oldest?: string; latest?: string }) =>
      lookupCommunicationChannelMessages({
        actingUserId: options.actingUserId,
        channel,
        provider: options.conversation.surface,
        ...(input.oldest ? { oldest: input.oldest } : {}),
        ...(input.latest ? { latest: input.latest } : {}),
      }),
  };
}
