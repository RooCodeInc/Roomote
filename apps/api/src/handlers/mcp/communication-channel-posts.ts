import type { CommunicationPostMessageInput } from '@roomote/communication';
import { and, db, eq, slackUserMappings } from '@roomote/db/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationTeamIdFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  type CommunicationProvider,
} from '@roomote/types';
import {
  findTeamsConversationServiceUrl,
  getCommunicationProviderAdapter,
  type RuntimeCommunicationProviderAdapter,
} from '@roomote/sdk/server';

import { getCommunicationReplyImages } from './communication-thread-reply-shared';
import { assertDiscordChannelAccess } from './discord-thread-lookup';
import { McpProxyError } from './proxy-utils';
import {
  absolutizeSetupMarkdownLinks,
  getSlackFallbackText,
} from './slack-message-content';
import { normalizeSlackChannelTarget } from './slack-thread-lookup';

type ChannelPostTaskRun = {
  id: number;
  taskId: string;
  payload: unknown;
  actingUserId?: string | null;
};

type ParsedChannelPostBody = {
  channel: string;
  threadTs?: string;
  text?: string;
  images: Array<{ artifactId: string }>;
};

type ResolvedChannelPostTarget = Pick<
  CommunicationPostMessageInput,
  'channelId' | 'threadId' | 'replyToMessageId' | 'serviceUrl'
>;

const SLACK_DM_ID_REGEX = /^D[A-Z0-9]{8,}$/i;
const SLACK_USER_ID_REGEX = /^U[A-Z0-9]{8,}$/i;
const SLACK_USER_MENTION_REGEX = /^<@([A-Z0-9]{9,})(?:\|[^>]+)?>$/i;

const PROVIDER_UNAVAILABLE_ERRORS: Record<
  CommunicationProvider,
  { message: string; status: number }
> = {
  slack: {
    message: 'No active Slack installation found for this deployment',
    status: 404,
  },
  teams: {
    message: 'Teams bot credentials are not configured for outbound posts',
    status: 503,
  },
  telegram: {
    message: 'Telegram bot token is not configured for outbound posts',
    status: 503,
  },
  discord: {
    message: 'Discord bot token is not configured for outbound posts',
    status: 503,
  },
};

function isOriginChannel(
  requested: string,
  originChannelId: string | null,
): boolean {
  return (
    Boolean(originChannelId) && requested.replace(/^#/, '') === originChannelId
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function resolveSlackTarget(params: {
  provider: Extract<RuntimeCommunicationProviderAdapter, { provider: 'slack' }>;
  parsedBody: ParsedChannelPostBody;
}): Promise<ResolvedChannelPostTarget> {
  const rawTarget = params.parsedBody.channel.trim();
  const userMention = rawTarget.match(SLACK_USER_MENTION_REGEX);
  const directMessageId = SLACK_DM_ID_REGEX.test(rawTarget)
    ? rawTarget.toUpperCase()
    : null;
  let slackUserId = userMention?.[1]?.toUpperCase() ?? null;
  if (!slackUserId && SLACK_USER_ID_REGEX.test(rawTarget)) {
    slackUserId = rawTarget.toUpperCase();
  }

  if (directMessageId || slackUserId) {
    if (!params.provider.teamId) {
      throw new McpProxyError(
        404,
        'No active Slack installation found for this task workspace',
      );
    }

    if (directMessageId) {
      slackUserId =
        await params.provider.getDirectMessageUserId(directMessageId);
    }

    if (!slackUserId) {
      throw new McpProxyError(
        404,
        'Slack DM recipient is not available for this workspace',
      );
    }

    const linkedUser = await db.query.slackUserMappings.findFirst({
      columns: { userId: true },
      where: and(
        eq(slackUserMappings.slackUserId, slackUserId),
        eq(slackUserMappings.slackTeamId, params.provider.teamId),
      ),
    });
    if (!linkedUser) {
      throw new McpProxyError(
        403,
        'Slack DM recipient must have a linked Roomote account in this workspace',
      );
    }

    const channelId =
      directMessageId ?? (await params.provider.openConversation(slackUserId));
    if (!channelId) {
      throw new McpProxyError(502, 'Could not open Slack direct message');
    }

    return {
      channelId,
      ...(params.parsedBody.threadTs
        ? { threadId: params.parsedBody.threadTs }
        : {}),
    };
  }

  const channelTarget = normalizeSlackChannelTarget(params.parsedBody.channel);
  if (!channelTarget) {
    throw new McpProxyError(400, 'channel is required');
  }
  if ('error' in channelTarget) {
    throw new McpProxyError(400, channelTarget.error);
  }

  const channelId = await params.provider.resolveChannelId(channelTarget.value);
  if (!channelId) {
    throw new McpProxyError(
      404,
      `Could not resolve Slack channel ${channelTarget.value}.`,
    );
  }

  const membership = await params.provider.isAppInChannel(channelId);
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

  return {
    channelId,
    ...(params.parsedBody.threadTs
      ? { threadId: params.parsedBody.threadTs }
      : {}),
  };
}

async function resolveTeamsTarget(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<ResolvedChannelPostTarget> {
  const originChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const originTarget = isOriginChannel(
    params.parsedBody.channel,
    originChannelId,
  );
  const serviceUrl = originTarget
    ? getCommunicationServiceUrlFromTaskPayload(params.taskRun.payload)
    : await findTeamsConversationServiceUrl(params.parsedBody.channel);

  if (!serviceUrl) {
    throw new McpProxyError(
      originTarget ? 503 : 404,
      originTarget
        ? 'Teams channel posts require the Bot Framework serviceUrl from the task payload, which is missing for this task'
        : `No active Teams installation found for conversation ${params.parsedBody.channel}`,
    );
  }

  const threadId = params.parsedBody.threadTs;
  return {
    channelId: params.parsedBody.channel,
    serviceUrl,
    ...(threadId ? { threadId, replyToMessageId: threadId } : {}),
  };
}

function resolveTelegramTarget(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): ResolvedChannelPostTarget {
  const originChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const threadId =
    params.parsedBody.threadTs ??
    (isOriginChannel(params.parsedBody.channel, originChannelId)
      ? (getCommunicationThreadIdFromTaskPayload(params.taskRun.payload) ??
        undefined)
      : undefined);

  return {
    channelId: params.parsedBody.channel,
    ...(threadId ? { threadId } : {}),
  };
}

async function resolveDiscordTarget(params: {
  provider: Extract<
    RuntimeCommunicationProviderAdapter,
    { provider: 'discord' }
  >;
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<ResolvedChannelPostTarget> {
  const originChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const originTarget = isOriginChannel(
    params.parsedBody.channel,
    originChannelId,
  );
  const requestedThreadId = params.parsedBody.threadTs?.replace(/^#/, '');

  if (requestedThreadId && !originTarget) {
    throw new McpProxyError(
      400,
      'Discord cross-channel posts cannot target a thread',
    );
  }

  if (!originTarget) {
    const channelId = params.parsedBody.channel.replace(/^#/, '');
    const targetChannel = await assertDiscordChannelAccess({
      provider: params.provider,
      channelId,
      isExplicitChannel: true,
      actingUserId: params.taskRun.actingUserId,
      requireSendPermission: true,
    });

    if (!targetChannel.guildId) {
      throw new McpProxyError(
        403,
        'Discord cross-channel posts only support guild channels',
      );
    }
    if ([10, 11, 12].includes(targetChannel.type)) {
      throw new McpProxyError(
        400,
        'Discord cross-channel posts cannot target a thread',
      );
    }
    if ([4, 15, 16].includes(targetChannel.type)) {
      throw new McpProxyError(
        400,
        'Discord cross-channel posts do not support category, forum, or media channels',
      );
    }

    return { channelId };
  }

  const storedThreadId =
    getCommunicationThreadIdFromTaskPayload(params.taskRun.payload) ??
    undefined;
  if (
    requestedThreadId &&
    requestedThreadId !== storedThreadId &&
    requestedThreadId !== originChannelId
  ) {
    throw new McpProxyError(
      403,
      'Discord channel posts are only available for the conversation this task was launched from',
    );
  }

  return {
    channelId: originChannelId!,
    ...(storedThreadId ? { threadId: storedThreadId } : {}),
  };
}

async function resolveChannelPostTarget(params: {
  provider: RuntimeCommunicationProviderAdapter;
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<ResolvedChannelPostTarget> {
  switch (params.provider.provider) {
    case 'slack':
      return resolveSlackTarget({
        provider: params.provider,
        parsedBody: params.parsedBody,
      });
    case 'teams':
      return resolveTeamsTarget(params);
    case 'telegram':
      return resolveTelegramTarget(params);
    case 'discord':
      return resolveDiscordTarget({ ...params, provider: params.provider });
  }
}

function buildProviderPostInput(params: {
  provider: CommunicationProvider;
  target: ResolvedChannelPostTarget;
  text: string | undefined;
  images: CommunicationPostMessageInput['images'];
}): CommunicationPostMessageInput {
  if (params.provider === 'slack') {
    const text = params.text
      ? absolutizeSetupMarkdownLinks(params.text)
      : undefined;
    return {
      ...params.target,
      text: getSlackFallbackText(text, params.images?.length ?? 0),
      ...(text ? { blocks: [{ type: 'markdown', text }] } : {}),
      images: params.images,
    };
  }

  return {
    ...params.target,
    ...(params.text ? { text: params.text } : {}),
    textFormat: 'markdown',
    images: params.images,
  };
}

export async function sendCommunicationChannelPost(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<Response> {
  const providerName =
    getCommunicationProviderFromTaskPayload(params.taskRun.payload) ?? 'slack';
  const provider = await getCommunicationProviderAdapter(providerName, {
    slackTeamId:
      providerName === 'slack'
        ? getCommunicationTeamIdFromTaskPayload(params.taskRun.payload)
        : undefined,
  });

  if (!provider) {
    const unavailable = PROVIDER_UNAVAILABLE_ERRORS[providerName];
    return jsonResponse({ error: unavailable.message }, unavailable.status);
  }

  try {
    const target = await resolveChannelPostTarget({
      provider,
      taskRun: params.taskRun,
      parsedBody: params.parsedBody,
    });
    const { images, errorResponse } = await getCommunicationReplyImages({
      taskRun: { id: params.taskRun.id, taskId: params.taskRun.taskId },
      parsedBody: params.parsedBody,
    });
    if (errorResponse) {
      return errorResponse;
    }

    const text = params.parsedBody.text?.trim() || undefined;
    if (!text && images.length === 0) {
      return jsonResponse(
        { error: 'Channel posts require text or image attachments' },
        400,
      );
    }

    let reply;
    try {
      reply = await provider.postMessage(
        buildProviderPostInput({
          provider: providerName,
          target,
          text,
          images,
        }),
      );
    } catch (error) {
      if (
        providerName === 'slack' &&
        error instanceof Error &&
        error.message === 'Slack chat.postMessage returned no message timestamp'
      ) {
        return jsonResponse(
          {
            error: params.parsedBody.threadTs
              ? 'Slack thread source message no longer exists'
              : error.message,
          },
          params.parsedBody.threadTs ? 409 : 502,
        );
      }
      throw error;
    }

    return jsonResponse({
      messageTs: reply.messageId,
      channelId: target.channelId,
    });
  } catch (error) {
    if (error instanceof McpProxyError) {
      return jsonResponse({ error: error.message }, error.httpStatus);
    }
    throw error;
  }
}
