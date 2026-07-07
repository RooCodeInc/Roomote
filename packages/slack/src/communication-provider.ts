import type {
  CommunicationChannelMessagesResult,
  CommunicationMessage,
  CommunicationPostMessageInput,
  CommunicationPostMessageResult,
  CommunicationProviderAdapter,
  CommunicationReactionResult,
  CommunicationThreadLookupResult,
} from '@roomote/communication/provider';

import { SlackNotifier } from './slack-notifier';
import type { SlackChannelMessage, SlackThreadMessage } from './types';

function normalizeSlackMessage(
  channelId: string,
  message: SlackThreadMessage | SlackChannelMessage,
): CommunicationMessage {
  return {
    provider: 'slack',
    id: message.ts,
    user: message.user,
    ...(message.username ? { username: message.username } : {}),
    ...(message.bot_id ? { botId: message.bot_id } : {}),
    text: message.text,
    channelId,
    ...('thread_ts' in message && message.thread_ts
      ? { threadId: message.thread_ts }
      : {}),
    fileCount: message.files?.length ?? 0,
    ...(message.files?.length
      ? {
          files: message.files.map((file) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimetype,
            size: file.size,
          })),
        }
      : {}),
  };
}

export class SlackCommunicationProvider implements CommunicationProviderAdapter {
  readonly provider = 'slack' as const;

  constructor(private readonly slack: SlackNotifier) {}

  async postMessage(
    input: CommunicationPostMessageInput,
  ): Promise<CommunicationPostMessageResult> {
    const imageBlocks =
      input.images?.map((image) => ({
        type: 'image',
        image_url: image.url,
        alt_text: image.altText,
      })) ?? [];
    const blocks = [...(input.blocks ?? []), ...imageBlocks];
    const messageId = await this.slack.postMessage({
      channel: input.channelId,
      ...(input.threadId ? { thread_ts: input.threadId } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(blocks.length > 0 ? { blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!messageId) {
      throw new Error('Slack chat.postMessage returned no message timestamp');
    }

    return {
      provider: 'slack',
      channelId: input.channelId,
      messageId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
  }

  async fetchThreadMessages(input: {
    channelId: string;
    messageId: string;
  }): Promise<CommunicationThreadLookupResult> {
    const message = await this.slack.getMessage({
      channel: input.channelId,
      messageTs: input.messageId,
    });

    if (!message) {
      throw new Error(`Slack message ${input.messageId} was not found`);
    }

    const threadId = message.thread_ts ?? message.ts;
    const threadMessages = await this.slack.fetchThreadMessages({
      channel: input.channelId,
      threadTs: threadId,
    });
    const messages = threadMessages.map((entry) =>
      normalizeSlackMessage(input.channelId, entry),
    );
    const matchedMessageIndex = messages.findIndex(
      (entry) => entry.id === input.messageId,
    );

    if (matchedMessageIndex === -1) {
      throw new Error(
        `Slack thread for message ${input.messageId} was not found`,
      );
    }

    return {
      provider: 'slack',
      channelId: input.channelId,
      requestedMessageId: input.messageId,
      threadId,
      matchedMessageIndex,
      messageCount: messages.length,
      messages,
    };
  }

  async fetchChannelMessages(input: {
    channelId: string;
    oldest?: string;
    latest?: string;
  }): Promise<CommunicationChannelMessagesResult> {
    const messages = (
      await this.slack.fetchChannelMessages({
        channel: input.channelId,
        ...(input.oldest ? { oldest: input.oldest } : {}),
        ...(input.latest ? { latest: input.latest } : {}),
      })
    ).map((entry) => normalizeSlackMessage(input.channelId, entry));

    return {
      provider: 'slack',
      channelId: input.channelId,
      ...(input.oldest ? { requestedOldest: input.oldest } : {}),
      ...(input.latest ? { requestedLatest: input.latest } : {}),
      messageCount: messages.length,
      messages,
    };
  }

  async addReaction(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<CommunicationReactionResult> {
    const added = await this.slack.addReaction({
      channel: input.channelId,
      timestamp: input.messageId,
      name: input.name,
    });

    if (!added) {
      throw new Error(
        `Slack reactions.add failed for channel ${input.channelId} at ${input.messageId}.`,
      );
    }

    return {
      provider: 'slack',
      channelId: input.channelId,
      messageId: input.messageId,
      name: input.name,
    };
  }
}
