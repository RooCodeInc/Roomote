import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import type {
  DiscordChannelMessagesResponse,
  DiscordThreadLookupResponse,
  RoomoteConfig,
} from './types.js';

async function postToDiscordEndpoint<
  TResponse,
  TRequest extends object = Record<string, unknown>,
>(
  config: RoomoteConfig,
  path: string,
  input: TRequest,
  errorPrefix: string,
): Promise<TResponse> {
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}/api/mcp/discord/${path}`,
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

export async function getDiscordThread(
  config: RoomoteConfig,
  input: {
    channel?: string;
    messageId?: string;
    messageLink?: string;
  },
): Promise<DiscordThreadLookupResponse> {
  return postToDiscordEndpoint<DiscordThreadLookupResponse>(
    config,
    'thread_lookup',
    input,
    'Failed to look up Discord thread',
  );
}

export async function getDiscordChannelMessages(
  config: RoomoteConfig,
  input: {
    channel?: string;
    oldest?: string;
    latest?: string;
  },
): Promise<DiscordChannelMessagesResponse> {
  return postToDiscordEndpoint<DiscordChannelMessagesResponse>(
    config,
    'channel_messages',
    input,
    'Failed to look up Discord channel messages',
  );
}
