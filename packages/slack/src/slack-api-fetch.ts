import { buildSlackApiUrl } from './slack-api-base-url';

const DEFAULT_SLACK_RATE_LIMIT_RETRY_AFTER_MS = 1_000;

/**
 * Ceiling for every Slack Web API request. Slack calls sit on user-facing
 * request paths, so a hung socket must fail fast instead of stalling the
 * caller for the platform-default (unbounded) socket timeout.
 */
export const SLACK_REQUEST_TIMEOUT_MS = 5_000;

/**
 * File downloads stream real payloads, so they get a longer ceiling than the
 * JSON API calls while still staying bounded.
 */
export const SLACK_DOWNLOAD_TIMEOUT_MS = 30_000;

type SlackApiBaseResponse = {
  ok: boolean;
  error?: string;
};

/**
 * Wraps `fetch` with a Slack-specific timeout. Callers already treat a thrown
 * fetch as "unavailable", so an aborted request surfaces through their
 * existing catch blocks unchanged.
 */
export function slackFetch(
  url: string,
  init: RequestInit = {},
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const { fetchImpl = fetch, timeoutMs = SLACK_REQUEST_TIMEOUT_MS } = options;

  return fetchImpl(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

export function getSlackRetryAfterMs(retryAfterHeader: string | null): number {
  const retryAfterSeconds = Number.parseFloat(retryAfterHeader ?? '');

  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
    return DEFAULT_SLACK_RATE_LIMIT_RETRY_AFTER_MS;
  }

  return Math.max(
    DEFAULT_SLACK_RATE_LIMIT_RETRY_AFTER_MS,
    Math.ceil(retryAfterSeconds * 1000),
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchSlackGetJson<
  TResponse extends SlackApiBaseResponse,
>(params: {
  token: string;
  endpoint: string;
  context: string;
  query?: URLSearchParams;
  fetchImpl?: typeof fetch;
  maxRateLimitRetries?: number;
  /** Caps each individual `Retry-After` wait so retries stay bounded. */
  maxRateLimitWaitMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<TResponse | null> {
  const {
    token,
    endpoint,
    context,
    query,
    fetchImpl = fetch,
    maxRateLimitRetries = 0,
    maxRateLimitWaitMs,
    sleepImpl = defaultSleep,
  } = params;

  let retryCount = 0;

  while (true) {
    const url = query
      ? `${buildSlackApiUrl(endpoint)}?${query.toString()}`
      : buildSlackApiUrl(endpoint);

    const response = await slackFetch(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
      { fetchImpl },
    );

    if (response.status === 429) {
      if (retryCount >= maxRateLimitRetries) {
        console.error(
          `[${context}] Slack ${endpoint} exhausted ${maxRateLimitRetries} rate-limit retries`,
        );
        return null;
      }

      retryCount += 1;

      const retryAfterMs = getSlackRetryAfterMs(
        response.headers.get('Retry-After'),
      );

      await sleepImpl(
        maxRateLimitWaitMs === undefined
          ? retryAfterMs
          : Math.min(retryAfterMs, maxRateLimitWaitMs),
      );
      continue;
    }

    if (!response.ok) {
      console.error(
        `[${context}] Slack ${endpoint} failed: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const result = (await response.json()) as TResponse;

    if (!result.ok) {
      console.error(
        `[${context}] Slack ${endpoint} error: ${result.error ?? 'unknown_error'}`,
      );
      return null;
    }

    return result;
  }
}
