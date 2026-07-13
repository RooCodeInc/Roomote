import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';
import {
  createTeamsCommunicationProviderFromRuntimeCredentials,
  createTelegramCommunicationProviderFromRuntimeCredentials,
} from '@roomote/sdk/server';

import { getCommunicationReplyImages } from './communication-thread-reply-shared';

type ChannelPostTaskRun = {
  id: number;
  taskId: string;
  payload: unknown;
};

type ParsedChannelPostBody = {
  channel: string;
  threadTs?: string;
  text?: string;
  images: Array<{ artifactId: string }>;
};

/**
 * Teams and Telegram have no channel-membership model equivalent to Slack's
 * `isAppInChannel`, so cross-surface channel posts are restricted to the
 * conversation the task was launched from — the only channel whose delivery
 * context (and, for Teams, serviceUrl) the task legitimately holds.
 */
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

  if (!isOwnChannel(params.parsedBody.channel, jobChannelId)) {
    return jsonResponse(
      {
        error:
          'Telegram channel posts are only available for the chat this task was launched from',
      },
      403,
    );
  }

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

  // Without an explicit thread target, keep the post in the task's own topic
  // so it lands next to the conversation instead of the chat's General topic.
  const threadId =
    params.parsedBody.threadTs ??
    getCommunicationThreadIdFromTaskPayload(params.taskRun.payload) ??
    undefined;

  const reply = await provider.postMessage({
    channelId: jobChannelId!,
    ...(threadId ? { threadId } : {}),
    ...(text ? { text } : {}),
    textFormat: 'markdown',
    images,
  });

  return jsonResponse({
    messageTs: reply.messageId,
    channelId: jobChannelId,
  });
}

async function sendTeamsChannelPost(params: {
  taskRun: ChannelPostTaskRun;
  parsedBody: ParsedChannelPostBody;
}): Promise<Response> {
  const jobChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(
    params.taskRun.payload,
  );

  if (!isOwnChannel(params.parsedBody.channel, jobChannelId) || !serviceUrl) {
    return jsonResponse(
      {
        error:
          'Teams channel posts are only available for the conversation this task was launched from',
      },
      403,
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
    channelId: jobChannelId!,
    serviceUrl,
    ...(threadTs ? { threadId: threadTs, replyToMessageId: threadTs } : {}),
    ...(text ? { text } : {}),
    textFormat: 'markdown',
    images,
  });

  return jsonResponse({
    messageTs: reply.messageId,
    channelId: jobChannelId,
  });
}

/**
 * Provider dispatch for the channel_post MCP endpoint, mirroring
 * `maybeSendCommunicationThreadReply`: tasks originating from Teams or
 * Telegram post through their communication provider, anything else falls
 * through to the Slack path.
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
    default:
      return null;
  }
}
