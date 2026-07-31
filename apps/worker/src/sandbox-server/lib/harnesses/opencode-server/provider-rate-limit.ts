import { asFiniteNumber, asRecord, asString } from '@roomote/types';

import {
  collectProviderErrorValues,
  extractProviderErrorHttpStatus,
} from './provider-error-recovery';

/** How many automatic continue attempts after a provider rate limit. */
export const DEFAULT_OPENCODE_RATE_LIMIT_MAX_RETRIES = 3;

/** Base backoff before the first rate-limit continue prompt (ms). */
export const DEFAULT_OPENCODE_RATE_LIMIT_BASE_DELAY_MS = 5_000;

/** Cap for exponential backoff between rate-limit continue prompts (ms). */
export const DEFAULT_OPENCODE_RATE_LIMIT_MAX_DELAY_MS = 60_000;

export const OPENCODE_RATE_LIMIT_RETRY_PROMPT_TEXT = [
  'Continue. The previous model request failed due to a temporary provider rate limit and was automatically retried.',
  'Resume from where you left off without restating the rate-limit error.',
].join(' ');

/**
 * True when an OpenCode session.error payload is an HTTP 429, including the
 * UnknownError-wrapped OpenRouter shape:
 * `{"code":429,"message":"Provider returned error","metadata":{"error_type":"rate_limit_exceeded"}}`
 *
 * OpenCode's own retry policy already covers APIError with isRetryable, but
 * that UnknownError payload falls through as a terminal session.error.
 */
export function isOpenCodeProviderRateLimitError(error: unknown): boolean {
  const values = collectProviderErrorValues(error);

  if (values.some((value) => asRecord(value)?.isRetryable === false)) {
    return false;
  }

  return extractProviderErrorHttpStatus(values) === 429;
}

/**
 * Prefer provider Retry-After headers when present; otherwise exponential
 * backoff from the attempt number (1-based).
 */
export function resolveOpenCodeRateLimitRetryDelayMs(options: {
  error: unknown;
  attemptNumber: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}): number {
  const baseDelayMs =
    options.baseDelayMs ?? DEFAULT_OPENCODE_RATE_LIMIT_BASE_DELAY_MS;
  const maxDelayMs =
    options.maxDelayMs ?? DEFAULT_OPENCODE_RATE_LIMIT_MAX_DELAY_MS;
  const attemptNumber = Math.max(1, options.attemptNumber);

  const record = asRecord(options.error);
  const data = asRecord(record?.data);
  const headers =
    asRecord(data?.responseHeaders) ?? asRecord(record?.responseHeaders);

  if (headers) {
    const retryAfterMs = asFiniteNumber(headers['retry-after-ms']);
    if (retryAfterMs !== undefined && retryAfterMs >= 0) {
      return Math.min(Math.max(0, retryAfterMs), maxDelayMs);
    }

    const retryAfter = asString(headers['retry-after']);
    if (retryAfter) {
      const asSeconds = Number.parseFloat(retryAfter);
      if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
        return Math.min(Math.ceil(asSeconds * 1000), maxDelayMs);
      }

      const asDateMs = Date.parse(retryAfter) - Date.now();
      if (!Number.isNaN(asDateMs) && asDateMs > 0) {
        return Math.min(Math.ceil(asDateMs), maxDelayMs);
      }
    }
  }

  const exponential = baseDelayMs * 2 ** (attemptNumber - 1);
  return Math.min(exponential, maxDelayMs);
}

export function formatOpenCodeRateLimitRetryNoticeText(options: {
  attemptNumber: number;
  maxAttempts: number;
  delayMs: number;
  errorSummary?: string;
}): string {
  const seconds = Math.max(1, Math.round(options.delayMs / 1000));
  const errorSummary = options.errorSummary?.trim();
  const headline = errorSummary
    ? `Provider rate limit: ${errorSummary}`
    : 'Provider rate limit hit';
  const attempt = `attempt ${options.attemptNumber}/${options.maxAttempts}`;

  return `${headline}\n\nRetrying in ${seconds}s (${attempt}).`;
}
