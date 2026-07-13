import { WebClient } from '@slack/web-api';

import { Env } from '@roomote/env';
import { isObservedTimeoutError, ObservedTimeoutError } from '@roomote/types';

import { getSlackApiBaseUrl } from './slack-api-base-url';

type SlackRequestError = Error & {
  code?: string;
  original?: {
    code?: string;
    message?: string;
    config?: {
      url?: string;
    };
  };
};

function redactSlackUrl(url: string): string {
  try {
    const parsed = new URL(url, getSlackApiBaseUrl());
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function resolveSlackRequestUrl(
  apiMethod: string,
  error: SlackRequestError,
): string {
  const originalUrl = error.original?.config?.url;

  if (typeof originalUrl === 'string' && originalUrl.length > 0) {
    return redactSlackUrl(originalUrl);
  }

  return redactSlackUrl(apiMethod);
}

function isSlackTimeoutError(error: unknown): error is SlackRequestError {
  if (!(error instanceof Error)) {
    return false;
  }

  const slackError = error as SlackRequestError;
  const codes = [slackError.code, slackError.original?.code];
  const messages = [slackError.message, slackError.original?.message]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  return (
    codes.some((code) =>
      ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'].includes(code ?? ''),
    ) || messages.some((message) => message.includes('timeout'))
  );
}

export function createSlackWebClient(token: string): WebClient {
  const timeoutMs = Env.R_SLACK_API_TIMEOUT_MS;
  const slackApiUrl = getSlackApiBaseUrl();

  const client = new WebClient(token, {
    slackApiUrl,
    timeout: timeoutMs,
  });

  // Wrap apiCall — the single entry point for all Slack Web API HTTP requests
  // (chat.postMessage, reactions.add, etc. all route through it internally).
  const originalApiCall = client.apiCall.bind(client);

  client.apiCall = (async (method, options) => {
    const startedAt = Date.now();

    try {
      return await originalApiCall(method, options);
    } catch (error) {
      if (isObservedTimeoutError(error)) {
        throw error;
      }

      if (isSlackTimeoutError(error)) {
        const timeoutDetails = {
          source: 'slack-web-api',
          operation: `apiCall(${method})`,
          method: 'POST',
          url: resolveSlackRequestUrl(method, error),
          durationMs: Date.now() - startedAt,
          timeoutMs,
        };

        console.error('[Slack Web API Timeout]', timeoutDetails);
        throw new ObservedTimeoutError(timeoutDetails);
      }

      throw error;
    }
  }) as WebClient['apiCall'];

  return client;
}
