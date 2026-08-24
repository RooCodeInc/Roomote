import type { FastAgentConversation } from '@roomote/types';

import {
  lookupCommunicationChannelMessages,
  lookupCommunicationMessageContext,
} from './mcp/communication-message-lookup';

const FAST_AGENT_CHAT_HISTORY_DEFAULT_LIMIT = 20;
const FAST_AGENT_CHAT_HISTORY_MAX_BYTES = 32 * 1024;
const FAST_AGENT_CHAT_HISTORY_MESSAGE_TEXT_MAX_BYTES = 8 * 1024;

type ChannelMessagesPayload = Awaited<
  ReturnType<typeof lookupCommunicationChannelMessages>
>;
type ChannelMessage = ChannelMessagesPayload['messages'][number];

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;

  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}\n...[message truncated]`;
}

function compactChannelMessage(message: ChannelMessage): ChannelMessage {
  const { files, ...rest } = message;
  return {
    ...rest,
    text: truncateUtf8(
      message.text,
      FAST_AGENT_CHAT_HISTORY_MESSAGE_TEXT_MAX_BYTES,
    ),
    ...(files?.length ? { files: files.slice(0, 10) } : {}),
  };
}

function paginateChannelMessages(
  result: ChannelMessagesPayload,
  input: { cursor?: string; limit?: number },
) {
  const candidates = input.cursor
    ? result.messages.filter((message) => message.id !== input.cursor)
    : result.messages;
  let messages = candidates
    .slice(-(input.limit ?? FAST_AGENT_CHAT_HISTORY_DEFAULT_LIMIT))
    .map(compactChannelMessage);

  const buildPage = () => {
    const hasMore = candidates.length > messages.length;
    const nextCursor = hasMore ? messages[0]?.id : undefined;
    return {
      ...result,
      messageCount: messages.length,
      messages,
      hasMore,
      ...(nextCursor
        ? {
            nextCursor,
            continuationHint: `Pass cursor: ${JSON.stringify(nextCursor)} to fetch the next older page.`,
          }
        : {}),
    };
  };

  while (
    messages.length > 1 &&
    Buffer.byteLength(JSON.stringify(buildPage())) >
      FAST_AGENT_CHAT_HISTORY_MAX_BYTES
  ) {
    messages = messages.slice(1);
  }

  if (
    messages.length === 1 &&
    Buffer.byteLength(JSON.stringify(buildPage())) >
      FAST_AGENT_CHAT_HISTORY_MAX_BYTES
  ) {
    const message = messages[0]!;
    messages = [
      {
        provider: message.provider,
        id: message.id,
        user: message.user,
        text: truncateUtf8(message.text, 2 * 1024),
        channelId: message.channelId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        fileCount: message.fileCount,
      },
    ];
  }

  return buildPage();
}

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
    getChatChannelMessages: async (input: {
      oldest?: string;
      latest?: string;
      cursor?: string;
      limit?: number;
    }) => {
      const result = await lookupCommunicationChannelMessages({
        actingUserId: options.actingUserId,
        channel,
        provider: options.conversation.surface,
        ...(input.oldest ? { oldest: input.oldest } : {}),
        ...(input.cursor
          ? { latest: input.cursor }
          : input.latest
            ? { latest: input.latest }
            : {}),
      });
      return paginateChannelMessages(result, input);
    },
  };
}
