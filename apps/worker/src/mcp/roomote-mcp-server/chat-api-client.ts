import { buildApiHeaders, fetchWithTimeout } from './api-client.js';
import { ChatDeliveryError } from './chat-delivery-error.js';
import type {
  CommunicationChannelMessagesResponse,
  CommunicationChannelsResponse,
  CommunicationMessageContextResponse,
  RoomoteConfig,
  ChannelPostResponse,
  SlackMutationResponse,
  SlackReactionAddResponse,
  SlackThreadReplyResponse,
} from './types.js';

const MCP_POST_MAX_503_RETRIES = 3;
const MCP_POST_RETRY_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToMcpEndpoint<
  TResponse,
  TRequest extends object = Record<string, unknown>,
>(
  config: RoomoteConfig,
  namespace: 'slack' | 'communication',
  path: string,
  input: TRequest,
  errorPrefix: string,
): Promise<TResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithTimeout(
      `${config.platformApiUrl}/api/mcp/${namespace}/${path}`,
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

    if (response.status === 503 && attempt < MCP_POST_MAX_503_RETRIES) {
      await sleep(MCP_POST_RETRY_DELAY_MS);
      continue;
    }

    const bodyText = await response.text();
    let parsedBody: {
      error?: unknown;
      retryable?: unknown;
      slackErrorCode?: unknown;
    } | null = null;
    try {
      parsedBody = JSON.parse(bodyText) as {
        error?: unknown;
        retryable?: unknown;
        slackErrorCode?: unknown;
      };
    } catch {
      parsedBody = null;
    }

    const errorDetail =
      typeof parsedBody?.error === 'string' ? parsedBody.error : bodyText;
    const message = `${errorPrefix}: ${response.status} ${errorDetail}`;

    if (parsedBody?.retryable === false) {
      throw new ChatDeliveryError({
        message,
        status: response.status,
        retryable: false,
        providerErrorCode:
          typeof parsedBody.slackErrorCode === 'string'
            ? parsedBody.slackErrorCode
            : undefined,
      });
    }

    throw new Error(message);
  }
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
  return postToMcpEndpoint(config, 'slack', path, input, errorPrefix);
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
  return postToMcpEndpoint(config, 'communication', path, input, errorPrefix);
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

export async function postToChannel(
  config: RoomoteConfig,
  input: {
    channel: string;
    threadTs?: string;
    text?: string;
    images?: Array<{ artifactId: string }>;
  },
): Promise<ChannelPostResponse> {
  return postToChatEndpoint<ChannelPostResponse>(
    config,
    'channel_post',
    input,
    'Failed to post to channel',
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

export async function getChatMessageContext(
  config: RoomoteConfig,
  input: {
    channel?: string;
    messageId?: string;
    messageLink?: string;
  },
): Promise<CommunicationMessageContextResponse> {
  return postToCommunicationLookupEndpoint<CommunicationMessageContextResponse>(
    config,
    'message_context',
    input,
    'Failed to look up chat message context',
  );
}

export async function listChatChannels(
  config: RoomoteConfig,
): Promise<CommunicationChannelsResponse> {
  return postToCommunicationLookupEndpoint<CommunicationChannelsResponse>(
    config,
    'channels',
    {},
    'Failed to list chat channels',
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

export async function suppressSlackReplyQuote(
  config: RoomoteConfig,
  input: { runId: number },
): Promise<SlackMutationResponse> {
  return postToChatEndpoint<SlackMutationResponse>(
    config,
    'suppress_reply_quote',
    input,
    'Failed to suppress Slack reply quote',
  );
}

export async function clearSlackReplyQuote(
  config: RoomoteConfig,
  input: {
    runId: number;
    quoteId: string;
  },
): Promise<SlackMutationResponse> {
  return postToChatEndpoint<SlackMutationResponse>(
    config,
    'clear_reply_quote',
    input,
    'Failed to clear Slack reply quote',
  );
}
