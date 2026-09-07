import {
  getCommunicationProviderDisplayName,
  getCommunicationProviderFromTaskPayload,
} from '@roomote/types';

import { COMMUNICATION_LOOKUP_STRATEGIES } from './communication-message-lookup-strategies';
import type {
  CommunicationChannelMessagesPayload,
  CommunicationLookupTaskRun,
  CommunicationMessageContextPayload,
  ParsedCommunicationReference,
  SupportedCommunicationLookupProvider,
} from './communication-message-lookup-types';
import { McpProxyError } from './proxy-utils';

export type { CommunicationLookupTaskRun } from './communication-message-lookup-types';

function parseReference(raw: string): ParsedCommunicationReference | null {
  for (const strategy of Object.values(COMMUNICATION_LOOKUP_STRATEGIES)) {
    const parsed = strategy.parseReference(raw);
    if (parsed) return { provider: strategy.provider, ...parsed };
  }
  return null;
}

function getTaskLookupProvider(
  taskRun?: CommunicationLookupTaskRun | null,
): SupportedCommunicationLookupProvider | null {
  const provider = taskRun
    ? getCommunicationProviderFromTaskPayload(taskRun.payload)
    : null;
  if (provider === 'slack' || provider === 'discord') return provider;
  if (provider) {
    throw new McpProxyError(
      400,
      `${getCommunicationProviderDisplayName(provider)} message lookup is not supported yet`,
    );
  }
  return null;
}

function assertMatchingReferences(
  left: ParsedCommunicationReference,
  right: ParsedCommunicationReference,
): void {
  if (
    left.provider !== right.provider ||
    left.channelId !== right.channelId ||
    (left.messageId && right.messageId && left.messageId !== right.messageId)
  ) {
    throw new McpProxyError(
      400,
      'channel and messageLink refer to different messages',
    );
  }
}

function resolveLookupProvider(options: {
  reference?: ParsedCommunicationReference | null;
  provider?: SupportedCommunicationLookupProvider;
  taskRun?: CommunicationLookupTaskRun | null;
}): SupportedCommunicationLookupProvider | null {
  if (
    options.reference &&
    options.provider &&
    options.reference.provider !== options.provider
  ) {
    throw new McpProxyError(
      400,
      'The supplied message or channel link does not match the communication provider',
    );
  }

  return (
    options.reference?.provider ??
    options.provider ??
    getTaskLookupProvider(options.taskRun)
  );
}

export async function lookupCommunicationMessageContext(options: {
  channel?: string;
  messageId?: string;
  messageLink?: string;
  provider?: SupportedCommunicationLookupProvider;
  taskRun?: CommunicationLookupTaskRun | null;
  actingUserId?: string | null;
}): Promise<CommunicationMessageContextPayload> {
  const messageLink = options.messageLink?.trim();
  const parsedMessageLink = messageLink ? parseReference(messageLink) : null;
  if (messageLink && !parsedMessageLink?.messageId) {
    throw new McpProxyError(
      400,
      'messageLink must be a Slack or Discord message link',
    );
  }

  const channel = options.channel?.trim();
  const parsedChannel = channel ? parseReference(channel) : null;
  if (parsedMessageLink && parsedChannel) {
    assertMatchingReferences(parsedMessageLink, parsedChannel);
  }

  const reference = parsedMessageLink ?? parsedChannel;
  if (
    reference &&
    channel &&
    !parsedChannel &&
    reference.channelId !== channel
  ) {
    throw new McpProxyError(
      400,
      'channel does not match the supplied message link',
    );
  }
  if (
    reference?.messageId &&
    options.messageId?.trim() &&
    reference.messageId !== options.messageId.trim()
  ) {
    throw new McpProxyError(
      400,
      'messageId does not match the supplied message link',
    );
  }

  const provider = resolveLookupProvider({
    reference,
    provider: options.provider,
    taskRun: options.taskRun,
  });
  if (!provider) {
    throw new McpProxyError(
      400,
      'A Slack or Discord message link is required when the task has no communication channel',
    );
  }

  const messageId = reference?.messageId ?? options.messageId?.trim();
  if (!messageId) {
    throw new McpProxyError(400, 'messageId or messageLink is required');
  }

  return COMMUNICATION_LOOKUP_STRATEGIES[provider].getMessageContext({
    ...(reference?.channelId
      ? { channel: reference.channelId }
      : channel
        ? { channel }
        : {}),
    messageId,
    ...(options.taskRun ? { taskRun: options.taskRun } : {}),
    ...(options.actingUserId ? { actingUserId: options.actingUserId } : {}),
  });
}

export async function lookupCommunicationChannelMessages(options: {
  channel?: string;
  oldest?: string;
  latest?: string;
  provider?: SupportedCommunicationLookupProvider;
  taskRun?: CommunicationLookupTaskRun | null;
  actingUserId?: string | null;
}): Promise<CommunicationChannelMessagesPayload> {
  const channel = options.channel?.trim();
  const reference = channel ? parseReference(channel) : null;
  const provider = resolveLookupProvider({
    reference,
    provider: options.provider,
    taskRun: options.taskRun,
  });
  if (!provider) {
    throw new McpProxyError(
      400,
      'A Slack or Discord channel/message link is required when the task has no communication channel',
    );
  }

  return COMMUNICATION_LOOKUP_STRATEGIES[provider].getChannelMessages({
    ...(reference?.channelId
      ? { channel: reference.channelId }
      : channel
        ? { channel }
        : {}),
    ...(options.oldest ? { oldest: options.oldest } : {}),
    ...(options.latest ? { latest: options.latest } : {}),
    ...(options.taskRun ? { taskRun: options.taskRun } : {}),
    ...(options.actingUserId ? { actingUserId: options.actingUserId } : {}),
  });
}
