import { SlackNotifier } from '@roomote/slack';
import {
  and,
  db,
  eq,
  slackInstallations,
  slackUserMappings,
} from '@roomote/db/server';
import {
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';

import { McpProxyError } from './proxy-utils';

const SLACK_CHANNEL_TARGET_ERROR =
  'channel must be a Slack channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>';
const SLACK_DIRECT_MESSAGE_ERROR =
  'direct message IDs are not supported; use a Slack channel ID or channel name instead';
const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]{8,}$/i;
const SLACK_DIRECT_MESSAGE_ID_REGEX = /^D[A-Z0-9]{8,}$/i;
const SLACK_CHANNEL_MENTION_REGEX = /^<#([A-Z0-9]{9,})(?:\|[^>]+)?>$/i;

type SlackThreadMessage = {
  ts: string;
  user: string;
  username?: string;
  text: string;
  bot_id?: string;
  thread_ts?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    size: number;
  }>;
};

type SlackThreadLookupPayload = {
  channelId: string;
  requestedMessageTs: string;
  threadTs: string;
  matchedMessageIndex: number;
  messageCount: number;
  messages: Array<{
    ts: string;
    user: string;
    username?: string;
    botId?: string;
    text: string;
    fileCount: number;
    files?: Array<{
      id: string;
      name: string;
      mimetype: string;
      filetype: string;
      size: number;
    }>;
  }>;
};

type SlackChannelMessagesPayload = {
  channelId: string;
  requestedOldest?: string;
  requestedLatest?: string;
  messageCount: number;
  messages: Array<{
    ts: string;
    user: string;
    username?: string;
    botId?: string;
    threadTs?: string;
    text: string;
    fileCount: number;
    files?: Array<{
      id: string;
      name: string;
      mimetype: string;
      filetype: string;
      size: number;
    }>;
  }>;
};

/**
 * Slack routing context for a run. Channel bindings live on the tasks row
 * (`tasks.slackChannelId` / `tasks.slackThreadTs`); the payload keeps its
 * legacy launch-time channel/thread fields as a fallback.
 */
type SlackReplyTargetCloudJob = {
  slackChannelId?: string | null;
  slackThreadTs: string | null;
  payload: unknown;
  actingUserId?: string | null;
};

export function normalizeSlackChannelTarget(
  rawChannel: string,
): { value: string } | { error: string } | null {
  const trimmedChannel = rawChannel.trim();

  if (!trimmedChannel) {
    return null;
  }

  const mentionMatch = trimmedChannel.match(SLACK_CHANNEL_MENTION_REGEX);
  const channelId = (mentionMatch?.[1] ?? trimmedChannel).toUpperCase();
  if (SLACK_DIRECT_MESSAGE_ID_REGEX.test(channelId)) {
    return { error: SLACK_DIRECT_MESSAGE_ERROR };
  }

  if (SLACK_CHANNEL_ID_REGEX.test(channelId)) {
    return { value: channelId };
  }

  const channelName = trimmedChannel.startsWith('#')
    ? trimmedChannel.slice(1)
    : trimmedChannel;

  if (!/^[^\s#<>|]+$/i.test(channelName)) {
    return { error: SLACK_CHANNEL_TARGET_ERROR };
  }

  return { value: `#${channelName.toLowerCase()}` };
}

function normalizeThreadLookupMessages(messages: SlackThreadMessage[]) {
  return messages.map((message) => ({
    ts: message.ts,
    user: message.user,
    ...(message.username ? { username: message.username } : {}),
    ...(message.bot_id ? { botId: message.bot_id } : {}),
    text: message.text,
    fileCount: message.files?.length ?? 0,
    ...(message.files?.length
      ? {
          files: message.files.map((file) => ({
            id: file.id,
            name: file.name,
            mimetype: file.mimetype,
            filetype: file.filetype,
            size: file.size,
          })),
        }
      : {}),
  }));
}

function normalizeSlackChannelMessages(messages: SlackThreadMessage[]) {
  return messages.map((message) => ({
    ts: message.ts,
    user: message.user,
    ...(message.username ? { username: message.username } : {}),
    ...(message.bot_id ? { botId: message.bot_id } : {}),
    ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
    text: message.text,
    fileCount: message.files?.length ?? 0,
    ...(message.files?.length
      ? {
          files: message.files.map((file) => ({
            id: file.id,
            name: file.name,
            mimetype: file.mimetype,
            filetype: file.filetype,
            size: file.size,
          })),
        }
      : {}),
  }));
}

export function getSlackReplyTarget(
  cloudJob: SlackReplyTargetCloudJob,
): { channel: string; threadTs?: string } | null {
  const channel =
    cloudJob.slackChannelId ?? getSlackChannelFromTaskPayload(cloudJob.payload);
  const threadTs =
    cloudJob.slackThreadTs ?? getSlackThreadTsFromTaskPayload(cloudJob.payload);

  if (channel) {
    return {
      channel,
      ...(threadTs ? { threadTs } : {}),
    };
  }

  return null;
}

export async function resolveVerifiedSlackChannel(options: {
  channel: string;
  slack: SlackNotifier;
  slackTeamId: string;
  actingSlackMembershipUserId?: string | null;
  requirePublicChannel?: boolean;
  publicChannelErrorMessage?: string;
}): Promise<string> {
  const channelTarget = normalizeSlackChannelTarget(options.channel);
  if (!channelTarget) {
    throw new McpProxyError(400, 'channel is required');
  }
  if ('error' in channelTarget) {
    throw new McpProxyError(400, channelTarget.error);
  }

  const resolvedChannelId = await options.slack.resolveChannelId(
    channelTarget.value,
  );
  if (!resolvedChannelId) {
    throw new McpProxyError(
      404,
      `Could not resolve Slack channel ${channelTarget.value}.`,
    );
  }

  const membership = await options.slack.isAppInChannel(resolvedChannelId);
  if (membership === false) {
    throw new McpProxyError(
      403,
      `Slack app is not a member of channel ${channelTarget.value}.`,
    );
  }

  if (membership === null) {
    throw new McpProxyError(
      502,
      `Could not verify Slack access for channel ${channelTarget.value}.`,
    );
  }

  if (!options.actingSlackMembershipUserId) {
    const isPublicChannel =
      await options.slack.isPublicChannel(resolvedChannelId);

    if (isPublicChannel === false) {
      throw new McpProxyError(
        403,
        options.publicChannelErrorMessage ??
          'Explicit Slack access without a linked acting Slack user is limited to public channels the app has joined.',
      );
    }

    if (isPublicChannel === null) {
      throw new McpProxyError(
        502,
        `Could not verify whether channel ${channelTarget.value} is public.`,
      );
    }
  }

  if (options.actingSlackMembershipUserId) {
    const linkedSlackUser = await db.query.slackUserMappings.findFirst({
      columns: { slackUserId: true },
      where: and(
        eq(slackUserMappings.userId, options.actingSlackMembershipUserId),
        eq(slackUserMappings.slackTeamId, options.slackTeamId),
      ),
    });

    if (!linkedSlackUser?.slackUserId) {
      throw new McpProxyError(
        403,
        'Explicit Slack access requires the acting user to have a linked Slack account.',
      );
    }

    const userMembership = await options.slack.isUserInChannel({
      channelId: resolvedChannelId,
      userId: linkedSlackUser.slackUserId,
    });

    if (userMembership === false) {
      throw new McpProxyError(
        403,
        `Linked Slack user is not a member of channel ${channelTarget.value}.`,
      );
    }

    if (userMembership === null) {
      throw new McpProxyError(
        502,
        `Could not verify linked Slack user access for channel ${channelTarget.value}.`,
      );
    }

    if (options.requirePublicChannel) {
      const isPublicChannel =
        await options.slack.isPublicChannel(resolvedChannelId);

      if (isPublicChannel === false) {
        throw new McpProxyError(
          403,
          options.publicChannelErrorMessage ??
            'Explicit Slack access without a linked acting Slack user is limited to public channels the app has joined.',
        );
      }

      if (isPublicChannel === null) {
        throw new McpProxyError(
          502,
          `Could not verify whether channel ${channelTarget.value} is public.`,
        );
      }
    }
  }

  return resolvedChannelId;
}

async function resolveSlackLookupChannel(options: {
  channel?: string;
  cloudJob?: SlackReplyTargetCloudJob | null;
  actingSlackMembershipUserId?: string | null;
  missingChannelError: string;
  missingLinkedAccountErrorMessage?: string;
  unlinkedUserPublicChannelErrorMessage?: string;
  requirePublicChannel?: boolean;
  publicChannelErrorMessage?: string;
}): Promise<{ channelId: string; slack: SlackNotifier }> {
  const slackOriginChannel = options.cloudJob
    ? (getSlackReplyTarget(options.cloudJob)?.channel ?? null)
    : null;
  const actingSlackMembershipUserId = options.cloudJob
    ? typeof options.cloudJob.actingUserId === 'string' &&
      options.cloudJob.actingUserId.trim().length > 0
      ? options.cloudJob.actingUserId
      : null
    : (options.actingSlackMembershipUserId ?? null);

  if (!slackOriginChannel && !options.channel) {
    throw new McpProxyError(400, options.missingChannelError);
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    columns: { botAccessToken: true, teamId: true },
    where: eq(slackInstallations.isActive, true),
  });

  if (!slackInstallation?.botAccessToken) {
    throw new McpProxyError(
      404,
      'No active Slack installation found for this deployment',
    );
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  let lookupChannel = slackOriginChannel;

  if (options.channel) {
    try {
      lookupChannel = await resolveVerifiedSlackChannel({
        channel: options.channel,
        slack,
        slackTeamId: slackInstallation.teamId,
        actingSlackMembershipUserId,
        requirePublicChannel: options.requirePublicChannel,
        publicChannelErrorMessage: options.publicChannelErrorMessage,
      });
    } catch (error) {
      if (
        error instanceof McpProxyError &&
        error.message ===
          'Explicit Slack access requires the acting user to have a linked Slack account.' &&
        options.missingLinkedAccountErrorMessage
      ) {
        throw new McpProxyError(403, options.missingLinkedAccountErrorMessage);
      }

      if (
        error instanceof McpProxyError &&
        error.message ===
          'Explicit Slack access without a linked acting Slack user is limited to public channels the app has joined.' &&
        options.unlinkedUserPublicChannelErrorMessage
      ) {
        throw new McpProxyError(
          403,
          options.unlinkedUserPublicChannelErrorMessage,
        );
      }

      throw error;
    }
  }

  if (!lookupChannel) {
    throw new McpProxyError(500, 'Slack lookup channel could not be resolved');
  }

  if (options.requirePublicChannel && !options.channel) {
    const isPublicChannel = await slack.isPublicChannel(lookupChannel);

    if (isPublicChannel === false) {
      throw new McpProxyError(
        403,
        options.publicChannelErrorMessage ??
          'Slack channel message lookup is limited to public channels the app has joined.',
      );
    }

    if (isPublicChannel === null) {
      throw new McpProxyError(
        502,
        `Could not verify whether Slack channel ${lookupChannel} is public.`,
      );
    }
  }

  return { channelId: lookupChannel, slack };
}

function normalizeSlackTimeBoundary(
  value: string | undefined,
  fieldName: 'oldest' | 'latest',
): { requested: string; slackTs: string; numericTs: number } | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const numericTs = Number.parseFloat(trimmed);
  if (Number.isFinite(numericTs) && /^\d+(?:\.\d+)?$/.test(trimmed)) {
    return {
      requested: trimmed,
      slackTs: trimmed,
      numericTs,
    };
  }

  const epochMs = Date.parse(trimmed);
  if (!Number.isFinite(epochMs)) {
    throw new McpProxyError(
      400,
      `${fieldName} must be a Slack timestamp or ISO 8601 date string`,
    );
  }

  const seconds = epochMs / 1000;
  return {
    requested: trimmed,
    slackTs: seconds.toFixed(6),
    numericTs: seconds,
  };
}

export async function lookupSlackThread(options: {
  messageTs: string;
  channel?: string;
  cloudJob?: SlackReplyTargetCloudJob | null;
  actingSlackMembershipUserId?: string | null;
}): Promise<SlackThreadLookupPayload> {
  const requestedMessageTs = options.messageTs.trim();
  if (!requestedMessageTs) {
    throw new McpProxyError(400, 'messageTs is required');
  }

  const { channelId: lookupChannel, slack } = await resolveSlackLookupChannel({
    channel: options.channel,
    cloudJob: options.cloudJob,
    actingSlackMembershipUserId: options.actingSlackMembershipUserId,
    missingChannelError:
      'channel is required when Slack thread lookup is not running from a Slack-originated job',
    missingLinkedAccountErrorMessage:
      'Explicit Slack thread lookup requires the acting user to have a linked Slack account.',
    unlinkedUserPublicChannelErrorMessage:
      'Explicit Slack thread lookup without a linked acting Slack user is limited to public channels the app has joined.',
  });

  const message = await slack.getMessage({
    channel: lookupChannel,
    messageTs: requestedMessageTs,
  });

  if (!message) {
    throw new McpProxyError(
      404,
      `Slack message ${requestedMessageTs} was not found in the originating channel`,
    );
  }

  const threadTs = message.thread_ts ?? message.ts;
  const threadMessages = await slack.fetchThreadMessages({
    channel: lookupChannel,
    threadTs,
  });
  if (threadMessages.length === 0) {
    throw new McpProxyError(
      502,
      `Slack thread for message ${requestedMessageTs} could not be fetched from the originating channel`,
    );
  }

  const normalizedMessages = normalizeThreadLookupMessages(threadMessages);
  const matchedMessageIndex = normalizedMessages.findIndex(
    (entry) => entry.ts === requestedMessageTs,
  );

  if (matchedMessageIndex === -1) {
    throw new McpProxyError(
      404,
      `Slack thread for message ${requestedMessageTs} could not be resolved`,
    );
  }

  return {
    channelId: lookupChannel,
    requestedMessageTs,
    threadTs,
    matchedMessageIndex,
    messageCount: normalizedMessages.length,
    messages: normalizedMessages,
  };
}

export async function lookupSlackChannelMessages(options: {
  channel?: string;
  oldest?: string;
  latest?: string;
  cloudJob?: SlackReplyTargetCloudJob | null;
  actingSlackMembershipUserId?: string | null;
}): Promise<SlackChannelMessagesPayload> {
  const oldestBoundary = normalizeSlackTimeBoundary(options.oldest, 'oldest');
  const latestBoundary = normalizeSlackTimeBoundary(options.latest, 'latest');

  if (
    oldestBoundary &&
    latestBoundary &&
    oldestBoundary.numericTs > latestBoundary.numericTs
  ) {
    throw new McpProxyError(400, 'oldest must be less than or equal to latest');
  }

  const { channelId, slack } = await resolveSlackLookupChannel({
    channel: options.channel,
    cloudJob: options.cloudJob,
    actingSlackMembershipUserId: options.actingSlackMembershipUserId,
    missingChannelError:
      'channel is required when Slack channel message lookup is not running from a Slack-originated job',
    requirePublicChannel: true,
    publicChannelErrorMessage:
      'Slack channel message lookup is limited to public channels the app has joined.',
  });

  let messages: SlackThreadMessage[];
  try {
    messages = await slack.fetchChannelMessages({
      channel: channelId,
      ...(oldestBoundary ? { oldest: oldestBoundary.slackTs } : {}),
      ...(latestBoundary ? { latest: latestBoundary.slackTs } : {}),
    });
  } catch {
    throw new McpProxyError(
      502,
      `Slack channel ${channelId} could not be fetched from Slack`,
    );
  }

  const normalizedMessages = normalizeSlackChannelMessages(messages);

  return {
    channelId,
    ...(oldestBoundary ? { requestedOldest: oldestBoundary.requested } : {}),
    ...(latestBoundary ? { requestedLatest: latestBoundary.requested } : {}),
    messageCount: normalizedMessages.length,
    messages: normalizedMessages,
  };
}
