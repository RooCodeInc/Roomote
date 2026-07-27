import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';
import {
  createDiscordCommunicationProviderFromRuntimeCredentials,
  createTeamsCommunicationProviderFromRuntimeCredentials,
  createTelegramCommunicationProviderFromRuntimeCredentials,
} from '@roomote/sdk/server';

import { getCommunicationReplyImages } from './communication-thread-reply-shared';
import { assertDiscordChannelAccess } from './discord-thread-lookup';
import { McpProxyError } from './proxy-utils';

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

function isOwnChannel(requested: string, jobChannelId: string | null): boolean {
  return Boolean(jobChannelId) && requested.replace(/^#/, '') === jobChannelId;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function sendTelegramChannelPost(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<Response> {
  const jobChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const isOriginChannel = isOwnChannel(params.parsedBody.channel, jobChannelId);

  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    return jsonResponse(
      { error: 'Telegram bot token is not configured for outbound posts' },
      503,
    );
  }

  const { images, errorResponse } = await getCommunicationReplyImages({
    taskRun: { id: params.taskRun.id, taskId: params.taskRun.taskId },
    parsedBody: params.parsedBody,
  });
  if (errorResponse) {
    return errorResponse;
  }

  const text = params.parsedBody.text?.trim();
  if (!text && images.length === 0) {
    return jsonResponse(
      { error: 'Channel posts require text or image attachments' },
      400,
    );
  }

  // Preserve the task topic only for its originating chat. A target chat's
  // topic is unknown, so cross-channel posts remain standalone by default.
  const threadId =
    params.parsedBody.threadTs ??
    (isOriginChannel
      ? getCommunicationThreadIdFromTaskPayload(params.taskRun.payload)
      : undefined) ??
    undefined;

  const reply = await provider.postMessage({
    channelId: params.parsedBody.channel,
    ...(threadId ? { threadId } : {}),
    ...(text ? { text } : {}),
    textFormat: 'markdown',
    images,
  });

  return jsonResponse({
    messageTs: reply.messageId,
    channelId: params.parsedBody.channel,
  });
}

async function sendTeamsChannelPost(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<Response> {
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(
    params.taskRun.payload,
  );

  if (!serviceUrl) {
    return jsonResponse(
      {
        error:
          'Teams channel posts require the Bot Framework serviceUrl from the task payload, which is missing for this task',
      },
      503,
    );
  }

  const provider =
    await createTeamsCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    return jsonResponse(
      { error: 'Teams bot credentials are not configured for outbound posts' },
      503,
    );
  }

  const { images, errorResponse } = await getCommunicationReplyImages({
    taskRun: { id: params.taskRun.id, taskId: params.taskRun.taskId },
    parsedBody: params.parsedBody,
  });
  if (errorResponse) {
    return errorResponse;
  }

  const text = params.parsedBody.text?.trim();
  if (!text && images.length === 0) {
    return jsonResponse(
      { error: 'Channel posts require text or image attachments' },
      400,
    );
  }

  const threadTs = params.parsedBody.threadTs;
  const reply = await provider.postMessage({
    channelId: params.parsedBody.channel,
    serviceUrl,
    ...(threadTs ? { threadId: threadTs, replyToMessageId: threadTs } : {}),
    ...(text ? { text } : {}),
    textFormat: 'markdown',
    images,
  });

  return jsonResponse({
    messageTs: reply.messageId,
    channelId: params.parsedBody.channel,
  });
}

async function sendDiscordChannelPost(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<Response> {
  const jobChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const isOriginChannel = isOwnChannel(params.parsedBody.channel, jobChannelId);

  const provider =
    await createDiscordCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    return jsonResponse(
      { error: 'Discord bot token is not configured for outbound posts' },
      503,
    );
  }

  if (!isOriginChannel) {
    // Cross-channel writes require the same linked-user check as explicit
    // Discord reads. The bot must also be able to resolve the target channel.
    try {
      const targetChannel = await assertDiscordChannelAccess({
        provider,
        channelId: params.parsedBody.channel.replace(/^#/, ''),
        isExplicitChannel: true,
        actingUserId: params.taskRun.actingUserId,
        requireSendPermission: true,
      });
      if (!targetChannel.guildId) {
        return jsonResponse(
          { error: 'Discord cross-channel posts only support guild channels' },
          403,
        );
      }
      if ([10, 11, 12].includes(targetChannel.type)) {
        return jsonResponse(
          { error: 'Discord cross-channel posts cannot target a thread' },
          400,
        );
      }
      if ([4, 15, 16].includes(targetChannel.type)) {
        return jsonResponse(
          {
            error:
              'Discord cross-channel posts do not support category, forum, or media channels',
          },
          400,
        );
      }
    } catch (error) {
      if (error instanceof McpProxyError) {
        return jsonResponse({ error: error.message }, error.httpStatus);
      }
      throw error;
    }
  }

  const { images, errorResponse } = await getCommunicationReplyImages({
    taskRun: { id: params.taskRun.id, taskId: params.taskRun.taskId },
    parsedBody: params.parsedBody,
  });
  if (errorResponse) {
    return errorResponse;
  }

  const text = params.parsedBody.text?.trim();
  if (!text && images.length === 0) {
    return jsonResponse(
      { error: 'Channel posts require text or image attachments' },
      400,
    );
  }

  // Discord posts land in the thread id directly (not the channel). Keep
  // cross-channel writes standalone, while task-originated posts retain their
  // existing thread behavior.
  const storedThreadId =
    getCommunicationThreadIdFromTaskPayload(params.taskRun.payload) ??
    undefined;
  const requestedThreadTs = params.parsedBody.threadTs?.replace(/^#/, '');

  if (requestedThreadTs && !isOriginChannel) {
    return jsonResponse(
      {
        error: 'Discord cross-channel posts cannot target a thread',
      },
      400,
    );
  }

  if (
    requestedThreadTs &&
    requestedThreadTs !== storedThreadId &&
    requestedThreadTs !== jobChannelId
  ) {
    return jsonResponse(
      {
        error:
          'Discord channel posts are only available for the conversation this task was launched from',
      },
      403,
    );
  }

  const channelId = isOriginChannel
    ? jobChannelId!
    : params.parsedBody.channel.replace(/^#/, '');
  const threadId = isOriginChannel ? storedThreadId : undefined;

  const reply = await provider.postMessage({
    channelId,
    ...(threadId ? { threadId } : {}),
    ...(text ? { text } : {}),
    textFormat: 'markdown',
    images,
  });

  return jsonResponse({
    messageTs: reply.messageId,
    channelId,
  });
}

/**
 * Provider dispatch for the channel_post MCP endpoint, mirroring
 * `maybeSendCommunicationThreadReply`: tasks originating from Teams,
 * Telegram, or Discord post through their communication provider, anything
 * else falls through to the Slack path.
 */
export async function maybeSendCommunicationChannelPost(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<Response | null> {
  switch (getCommunicationProviderFromTaskPayload(params.taskRun.payload)) {
    case 'teams':
      return sendTeamsChannelPost(params);
    case 'telegram':
      return sendTelegramChannelPost(params);
    case 'discord':
      return sendDiscordChannelPost(params);
    default:
      return null;
  }
}
