import { buildApiHeaders, parseApiError } from './api-client.js';
import type {
  RoomoteConfig,
  SlackChannelMessagesResponse,
  SlackChannelPostResponse,
  SlackMutationResponse,
  SlackReactionAddResponse,
  SlackThreadLookupResponse,
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
    const response = await fetch(
      `${config.platformApiUrl}/api/mcp/slack/${path}`,
      {
        method: 'POST',
        headers: buildApiHeaders(config, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(input),
      },
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

export async function getSlackThread(
  config: RoomoteConfig,
  input: {
    channel?: string;
    messageTs: string;
  },
): Promise<SlackThreadLookupResponse> {
  return postToChatEndpoint<SlackThreadLookupResponse>(
    config,
    'thread_lookup',
    input,
    'Failed to look up Slack thread',
  );
}

export async function getSlackChannelMessages(
  config: RoomoteConfig,
  input: {
    channel?: string;
    oldest?: string;
    latest?: string;
  },
): Promise<SlackChannelMessagesResponse> {
  return postToChatEndpoint<SlackChannelMessagesResponse>(
    config,
    'channel_messages',
    input,
    'Failed to look up Slack channel messages',
  );
}

export async function trackSlackReplyQuote(
  config: RoomoteConfig,
  input: {
    cloudJobId: number;
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
    cloudJobId: number;
  },
): Promise<SlackMutationResponse> {
  return postToChatEndpoint<SlackMutationResponse>(
    config,
    'clear_reply_quote',
    input,
    'Failed to clear Slack reply quote',
  );
}
