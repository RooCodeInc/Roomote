import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import type {
  CommunicationChannelMessagesResponse,
  CommunicationThreadLookupResponse,
  RoomoteConfig,
  SlackChannelPostResponse,
  SlackMutationResponse,
  SlackReactionAddResponse,
  SlackThreadReplyResponse,
} from './types.js';

const CHAT_THREAD_REPLY_MAX_503_RETRIES = 3;
const CHAT_THREAD_REPLY_RETRY_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToChatEndpoint<
  TResponse,
  TRequest extends object = Record<string, unknown>,
>(
  config: RoomoteConfig,
  path: string,
  input: TRequest,
  errorPrefix: string,
): Promise<TResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithTimeout(
      `${config.platformApiUrl}/api/mcp/slack/${path}`,
      {
        method: 'POST',
        headers: buildApiHeaders(config, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(input),
      },
      { label: errorPrefix },
    );

    if (response.ok) {
      return (await response.json()) as TResponse;
    }

    if (
      response.status === 503 &&
      attempt < CHAT_THREAD_REPLY_MAX_503_RETRIES
    ) {
      await sleep(CHAT_THREAD_REPLY_RETRY_DELAY_MS);
      continue;
    }

    const error = await parseApiError(response);
    throw new Error(`${errorPrefix}: ${response.status} ${error}`);
  }
}

async function postToCommunicationLookupEndpoint<
  TResponse,
  TRequest extends object = Record<string, unknown>,
>(
  config: RoomoteConfig,
  path: string,
  input: TRequest,
  errorPrefix: string,
): Promise<TResponse> {
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/mcp/communication/${path}`,
    {
      method: 'POST',
      headers: buildApiHeaders(config, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(input),
    },
    { label: errorPrefix },
  );

  if (response.ok) {
    return (await response.json()) as TResponse;
  }

  const error = await parseApiError(response);
  throw new Error(`${errorPrefix}: ${response.status} ${error}`);
}

export async function replyToChatThread(
  config: RoomoteConfig,
  input: {
    text?: string;
    blocks?: unknown[];
    images?: Array<{ artifactId: string }>;
  },
): Promise<SlackThreadReplyResponse> {
  return postToChatEndpoint<SlackThreadReplyResponse>(
    config,
    'thread_reply',
    input,
    'Failed to reply to chat thread',
  );
}

export async function replyToSlackThread(
  config: RoomoteConfig,
  input: {
    text?: string;
    blocks?: unknown[];
    images?: Array<{ artifactId: string }>;
  },
): Promise<SlackThreadReplyResponse> {
  return postToChatEndpoint<SlackThreadReplyResponse>(
    config,
    'thread_reply',
    input,
    'Failed to reply to Slack thread',
  );
}

export async function postToSlackChannel(
  config: RoomoteConfig,
  input: {
    channel: string;
    threadTs?: string;
    text?: string;
    images?: Array<{ artifactId: string }>;
  },
): Promise<SlackChannelPostResponse> {
  return postToChatEndpoint<SlackChannelPostResponse>(
    config,
    'channel_post',
    input,
    'Failed to post to Slack channel',
  );
}

export async function addReactionToChatMessage(
  config: RoomoteConfig,
  input: {
    channel: string;
    messageTs: string;
    name: string;
  },
): Promise<SlackReactionAddResponse> {
  return postToChatEndpoint<SlackReactionAddResponse>(
    config,
    'reaction_add',
    input,
    'Failed to add chat reaction',
  );
}

export async function addReactionToSlackMessage(
  config: RoomoteConfig,
  input: {
    channel: string;
    messageTs: string;
    name: string;
  },
): Promise<SlackReactionAddResponse> {
  return postToChatEndpoint<SlackReactionAddResponse>(
    config,
    'reaction_add',
    input,
    'Failed to add Slack reaction',
  );
}

export async function getChatThread(
  config: RoomoteConfig,
  input: {
    channel?: string;
    messageId?: string;
    messageLink?: string;
  },
): Promise<CommunicationThreadLookupResponse> {
  return postToCommunicationLookupEndpoint<CommunicationThreadLookupResponse>(
    config,
    'thread_lookup',
    input,
    'Failed to look up chat thread',
  );
}

export async function getChatChannelMessages(
  config: RoomoteConfig,
  input: {
    channel?: string;
    oldest?: string;
    latest?: string;
  },
): Promise<CommunicationChannelMessagesResponse> {
  return postToCommunicationLookupEndpoint<CommunicationChannelMessagesResponse>(
    config,
    'channel_messages',
    input,
    'Failed to look up chat channel messages',
  );
}

export async function trackSlackReplyQuote(
  config: RoomoteConfig,
  input: {
    runId: number;
    text: string;
    userName: string;
  },
): Promise<SlackMutationResponse> {
  return postToChatEndpoint<SlackMutationResponse>(
    config,
    'track_reply_quote',
    input,
    'Failed to track Slack reply quote',
  );
}

export async function clearSlackReplyQuote(
  config: RoomoteConfig,
  input: {
    runId: number;
  },
): Promise<SlackMutationResponse> {
  return postToChatEndpoint<SlackMutationResponse>(
    config,
    'clear_reply_quote',
    input,
    'Failed to clear Slack reply quote',
  );
}
