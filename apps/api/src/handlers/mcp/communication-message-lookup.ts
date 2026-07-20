import type { CommunicationProvider } from '@roomote/types';
import {
  getCommunicationProviderFromTaskPayload,
  getCommunicationProviderDisplayName,
  parseDiscordMessagePermalink,
  parseSlackMessagePermalink,
} from '@roomote/types';

import {
  lookupDiscordChannelMessages,
  lookupDiscordThread,
} from './discord-thread-lookup';
import { McpProxyError } from './proxy-utils';
import {
  lookupSlackChannelMessages,
  lookupSlackThread,
} from './slack-thread-lookup';

export type CommunicationLookupTaskRun = {
  actingUserId?: string | null;
  payload: unknown;
  slackChannelId?: string | null;
  slackThreadTs?: string | null;
};

type SupportedLookupProvider = Extract<
  CommunicationProvider,
  'slack' | 'discord'
>;

type ParsedMessageReference = {
  provider: SupportedLookupProvider;
  channelId: string;
  messageId: string;
};

type CommunicationLookupMessage = {
  provider: SupportedLookupProvider;
  id: string;
  user: string;
  username?: string;
  botId?: string;
  text: string;
  channelId: string;
  threadId?: string;
  fileCount: number;
  files?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    url?: string;
  }>;
};

type CommunicationThreadLookupPayload = {
  provider: SupportedLookupProvider;
  channelId: string;
  requestedMessageId: string;
  threadId: string;
  matchedMessageIndex: number;
  messageCount: number;
  messages: CommunicationLookupMessage[];
};

type CommunicationChannelMessagesPayload = {
  provider: SupportedLookupProvider;
  channelId: string;
  requestedOldest?: string;
  requestedLatest?: string;
  messageCount: number;
  messages: CommunicationLookupMessage[];
};

function parseMessageReference(raw: string): ParsedMessageReference | null {
  const discord = parseDiscordMessagePermalink(raw);
  if (discord?.messageId) {
    return {
      provider: 'discord',
      channelId: discord.channelId,
      messageId: discord.messageId,
    };
  }

  const slack = parseSlackMessagePermalink(raw);
  if (slack) {
    return {
      provider: 'slack',
      channelId: slack.channelId,
      messageId: slack.messageId,
    };
  }

  return null;
}

function parseChannelReference(
  raw: string,
): Omit<ParsedMessageReference, 'messageId'> | null {
  const discord = parseDiscordMessagePermalink(raw);
  if (discord) {
    return { provider: 'discord', channelId: discord.channelId };
  }

  const slack = parseSlackMessagePermalink(raw);
  if (slack) {
    return { provider: 'slack', channelId: slack.channelId };
  }

  return null;
}

function inferProviderFromRawTarget(options: {
  channel?: string;
  messageId?: string;
}): SupportedLookupProvider | null {
  const channel = options.channel?.trim() ?? '';
  const messageId = options.messageId?.trim() ?? '';

  if (/^\d+$/.test(channel)) return 'discord';
  if (
    channel.startsWith('#') ||
    channel.startsWith('<#') ||
    /^[CGD][A-Z0-9]{8,}$/i.test(channel) ||
    (channel.length > 0 && !/^\d+$/.test(channel))
  ) {
    return 'slack';
  }

  if (/^\d+\.\d+$/.test(messageId)) return 'slack';
  if (/^\d+$/.test(messageId)) return 'discord';
  return null;
}

function resolveLookupProvider(options: {
  explicitProvider?: SupportedLookupProvider;
  taskRun?: CommunicationLookupTaskRun | null;
  channel?: string;
  messageId?: string;
}): SupportedLookupProvider {
  if (options.explicitProvider) return options.explicitProvider;

  const originProvider = options.taskRun
    ? getCommunicationProviderFromTaskPayload(options.taskRun.payload)
    : null;
  if (originProvider === 'slack' || originProvider === 'discord') {
    return originProvider;
  }
  if (originProvider) {
    throw new McpProxyError(
      400,
      `${getCommunicationProviderDisplayName(originProvider)} message lookup is not supported yet`,
    );
  }

  const inferred = inferProviderFromRawTarget(options);
  if (inferred) return inferred;

  throw new McpProxyError(
    400,
    'A Slack or Discord message/channel link is required when the task has no communication channel',
  );
}

function assertMatchingExplicitValue(options: {
  field: string;
  explicit?: string;
  parsed?: string;
}): void {
  if (
    options.explicit?.trim() &&
    options.parsed &&
    options.explicit.trim() !== options.parsed
  ) {
    throw new McpProxyError(
      400,
      `${options.field} does not match the supplied message link`,
    );
  }
}

function toSlackLookupTaskRun(taskRun: CommunicationLookupTaskRun) {
  return {
    ...taskRun,
    slackThreadTs: taskRun.slackThreadTs ?? null,
  };
}

export async function lookupCommunicationThread(options: {
  channel?: string;
  messageId?: string;
  messageLink?: string;
  taskRun?: CommunicationLookupTaskRun | null;
  actingUserId?: string | null;
}): Promise<CommunicationThreadLookupPayload> {
  const rawLink = options.messageLink?.trim();
  const channelLink = options.channel?.trim()
    ? parseMessageReference(options.channel)
    : null;
  const parsedLink = rawLink ? parseMessageReference(rawLink) : channelLink;

  if (rawLink && !parsedLink) {
    throw new McpProxyError(
      400,
      'messageLink must be a Slack or Discord message link',
    );
  }

  assertMatchingExplicitValue({
    field: 'channel',
    explicit: channelLink ? undefined : options.channel,
    parsed: parsedLink?.channelId,
  });
  assertMatchingExplicitValue({
    field: 'messageId',
    explicit: options.messageId,
    parsed: parsedLink?.messageId,
  });

  const channel = parsedLink?.channelId ?? options.channel?.trim();
  const messageId = parsedLink?.messageId ?? options.messageId?.trim();
  if (!messageId) {
    throw new McpProxyError(400, 'messageId or messageLink is required');
  }

  const provider = resolveLookupProvider({
    explicitProvider: parsedLink?.provider,
    taskRun: options.taskRun,
    channel,
    messageId,
  });

  if (provider === 'discord') {
    const result = await lookupDiscordThread({
      ...(channel ? { channel } : {}),
      messageId,
      ...(options.taskRun ? { taskRun: options.taskRun } : {}),
      ...(!options.taskRun && options.actingUserId
        ? { actingDiscordMembershipUserId: options.actingUserId }
        : {}),
    });

    return {
      provider,
      channelId: result.channelId,
      requestedMessageId: result.requestedMessageId,
      threadId: result.threadId,
      matchedMessageIndex: result.matchedMessageIndex,
      messageCount: result.messageCount,
      messages: result.messages.map((message) => ({
        provider,
        ...message,
        channelId: result.channelId,
        threadId: result.threadId,
      })),
    };
  }

  const result = await lookupSlackThread({
    ...(channel ? { channel } : {}),
    messageTs: messageId,
    ...(options.taskRun
      ? { taskRun: toSlackLookupTaskRun(options.taskRun) }
      : {}),
    ...(!options.taskRun && options.actingUserId
      ? { actingSlackMembershipUserId: options.actingUserId }
      : {}),
  });

  return {
    provider,
    channelId: result.channelId,
    requestedMessageId: result.requestedMessageTs,
    threadId: result.threadTs,
    matchedMessageIndex: result.matchedMessageIndex,
    messageCount: result.messageCount,
    messages: result.messages.map((message) => ({
      provider,
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
}

export async function lookupCommunicationChannelMessages(options: {
  channel?: string;
  oldest?: string;
  latest?: string;
  taskRun?: CommunicationLookupTaskRun | null;
  actingUserId?: string | null;
}): Promise<CommunicationChannelMessagesPayload> {
  const parsedChannel = options.channel?.trim()
    ? parseChannelReference(options.channel)
    : null;
  const channel = parsedChannel?.channelId ?? options.channel?.trim();
  const provider = resolveLookupProvider({
    explicitProvider: parsedChannel?.provider,
    taskRun: options.taskRun,
    channel,
  });

  if (provider === 'discord') {
    const result = await lookupDiscordChannelMessages({
      ...(channel ? { channel } : {}),
      ...(options.oldest ? { oldest: options.oldest } : {}),
      ...(options.latest ? { latest: options.latest } : {}),
      ...(options.taskRun ? { taskRun: options.taskRun } : {}),
      ...(!options.taskRun && options.actingUserId
        ? { actingDiscordMembershipUserId: options.actingUserId }
        : {}),
    });

    return {
      provider,
      channelId: result.channelId,
      ...(result.requestedOldest
        ? { requestedOldest: result.requestedOldest }
        : {}),
      ...(result.requestedLatest
        ? { requestedLatest: result.requestedLatest }
        : {}),
      messageCount: result.messageCount,
      messages: result.messages.map((message) => ({
        provider,
        ...message,
        channelId: result.channelId,
      })),
    };
  }

  const result = await lookupSlackChannelMessages({
    ...(channel ? { channel } : {}),
    ...(options.oldest ? { oldest: options.oldest } : {}),
    ...(options.latest ? { latest: options.latest } : {}),
    ...(options.taskRun
      ? { taskRun: toSlackLookupTaskRun(options.taskRun) }
      : {}),
    ...(!options.taskRun && options.actingUserId
      ? { actingSlackMembershipUserId: options.actingUserId }
      : {}),
  });

  return {
    provider,
    channelId: result.channelId,
    ...(result.requestedOldest
      ? { requestedOldest: result.requestedOldest }
      : {}),
    ...(result.requestedLatest
      ? { requestedLatest: result.requestedLatest }
      : {}),
    messageCount: result.messageCount,
    messages: result.messages.map((message) => ({
      provider,
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
}
