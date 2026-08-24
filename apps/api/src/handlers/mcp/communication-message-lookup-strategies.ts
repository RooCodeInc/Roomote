import {
  parseDiscordMessagePermalink,
  parseSlackChannelPermalink,
  parseSlackMessagePermalink,
} from '@roomote/types';

import {
  lookupDiscordChannelMessages,
  lookupDiscordThread,
} from './discord-thread-lookup';
import {
  lookupSlackChannelMessages,
  lookupSlackThread,
} from './slack-thread-lookup';
import type {
  CommunicationLookupStrategy,
  CommunicationLookupTaskRun,
  SupportedCommunicationLookupProvider,
} from './communication-message-lookup-types';

function toSlackLookupTaskRun(taskRun: CommunicationLookupTaskRun) {
  return {
    ...taskRun,
    slackThreadTs: taskRun.slackThreadTs ?? null,
  };
}

const discordLookupStrategy: CommunicationLookupStrategy = {
  provider: 'discord',
  parseReference(raw) {
    const parsed = parseDiscordMessagePermalink(raw);
    return parsed
      ? {
          channelId: parsed.channelId,
          ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
        }
      : null;
  },
  async getMessageContext(options) {
    const result = await lookupDiscordThread({
      ...(options.channel ? { channel: options.channel } : {}),
      messageId: options.messageId,
      ...(options.taskRun ? { taskRun: options.taskRun } : {}),
      ...(!options.taskRun && options.actingUserId
        ? { actingDiscordMembershipUserId: options.actingUserId }
        : {}),
    });

    return {
      provider: 'discord',
      channelId: result.channelId,
      requestedMessageId: result.requestedMessageId,
      threadId: result.threadId,
      matchedMessageIndex: result.matchedMessageIndex,
      messageCount: result.messageCount,
      messages: result.messages.map((message) => ({
        provider: 'discord',
        ...message,
        channelId: result.channelId,
        threadId: result.threadId,
      })),
    };
  },
  async getChannelMessages(options) {
    const result = await lookupDiscordChannelMessages({
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.oldest ? { oldest: options.oldest } : {}),
      ...(options.latest ? { latest: options.latest } : {}),
      ...(options.taskRun ? { taskRun: options.taskRun } : {}),
      ...(!options.taskRun && options.actingUserId
        ? { actingDiscordMembershipUserId: options.actingUserId }
        : {}),
    });

    return {
      provider: 'discord',
      channelId: result.channelId,
      ...(result.requestedOldest
        ? { requestedOldest: result.requestedOldest }
        : {}),
      ...(result.requestedLatest
        ? { requestedLatest: result.requestedLatest }
        : {}),
      messageCount: result.messageCount,
      messages: result.messages.map((message) => ({
        provider: 'discord',
        ...message,
        channelId: result.channelId,
      })),
    };
  },
};

const slackLookupStrategy: CommunicationLookupStrategy = {
  provider: 'slack',
  parseReference(raw) {
    const message = parseSlackMessagePermalink(raw);
    if (message) {
      return { channelId: message.channelId, messageId: message.messageId };
    }
    const channel = parseSlackChannelPermalink(raw);
    return channel ? { channelId: channel.channelId } : null;
  },
  async getMessageContext(options) {
    const result = await lookupSlackThread({
      ...(options.channel ? { channel: options.channel } : {}),
      messageTs: options.messageId,
      ...(options.slackTeamId ? { slackTeamId: options.slackTeamId } : {}),
      ...(options.taskRun
        ? { taskRun: toSlackLookupTaskRun(options.taskRun) }
        : {}),
      ...(!options.taskRun && options.actingUserId
        ? { actingSlackMembershipUserId: options.actingUserId }
        : {}),
    });

    return {
      provider: 'slack',
      channelId: result.channelId,
      requestedMessageId: result.requestedMessageTs,
      threadId: result.threadTs,
      matchedMessageIndex: result.matchedMessageIndex,
      messageCount: result.messageCount,
      messages: result.messages.map((message) => ({
        provider: 'slack',
        id: message.ts,
        user: message.user,
        ...(message.username ? { username: message.username } : {}),
        ...(message.botId ? { botId: message.botId } : {}),
        text: message.text,
        channelId: result.channelId,
        threadId: result.threadTs,
        fileCount: message.fileCount,
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
      })),
    };
  },
  async getChannelMessages(options) {
    const result = await lookupSlackChannelMessages({
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.oldest ? { oldest: options.oldest } : {}),
      ...(options.latest ? { latest: options.latest } : {}),
      ...(options.slackTeamId ? { slackTeamId: options.slackTeamId } : {}),
      ...(options.taskRun
        ? { taskRun: toSlackLookupTaskRun(options.taskRun) }
        : {}),
      ...(!options.taskRun && options.actingUserId
        ? { actingSlackMembershipUserId: options.actingUserId }
        : {}),
    });

    return {
      provider: 'slack',
      channelId: result.channelId,
      ...(result.requestedOldest
        ? { requestedOldest: result.requestedOldest }
        : {}),
      ...(result.requestedLatest
        ? { requestedLatest: result.requestedLatest }
        : {}),
      messageCount: result.messageCount,
      messages: result.messages.map((message) => ({
        provider: 'slack',
        id: message.ts,
        user: message.user,
        ...(message.username ? { username: message.username } : {}),
        ...(message.botId ? { botId: message.botId } : {}),
        text: message.text,
        channelId: result.channelId,
        ...(message.threadTs ? { threadId: message.threadTs } : {}),
        fileCount: message.fileCount,
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
      })),
    };
  },
};

export const COMMUNICATION_LOOKUP_STRATEGIES = {
  slack: slackLookupStrategy,
  discord: discordLookupStrategy,
} as const satisfies Record<
  SupportedCommunicationLookupProvider,
  CommunicationLookupStrategy
>;
