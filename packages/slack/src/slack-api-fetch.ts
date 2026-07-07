import { buildSlackApiUrl } from './slack-api-base-url';

const DEFAULT_SLACK_RATE_LIMIT_RETRY_AFTER_MS = 1_000;

type SlackApiBaseResponse = {
  ok: boolean;
  error?: string;
};

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

export async function fetchSlackGetJson<
  TResponse extends SlackApiBaseResponse,
>(params: {
  token: string;
  endpoint: string;
  context: string;
  query?: URLSearchParams;
  fetchImpl?: typeof fetch;
  maxRateLimitRetries?: number;
}): Promise<TResponse | null> {
  const {
    token,
    endpoint,
    context,
    query,
    fetchImpl = fetch,
    maxRateLimitRetries = 0,
  } = params;

  let retryCount = 0;

  while (true) {
    const url = query
      ? `${buildSlackApiUrl(endpoint)}?${query.toString()}`
      : buildSlackApiUrl(endpoint);

    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (response.status === 429) {
      if (retryCount >= maxRateLimitRetries) {
        console.error(
          `[${context}] Slack ${endpoint} exhausted ${maxRateLimitRetries} rate-limit retries`,
        );
        return null;
      }

      retryCount += 1;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          getSlackRetryAfterMs(response.headers.get('Retry-After')),
        ),
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
