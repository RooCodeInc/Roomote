import {
  INFERENCE_PROVIDER_MAX_RETRIES,
  INFERENCE_PROVIDER_RATE_LIMIT_BASE_DELAY_MS,
  INFERENCE_PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
  asRecord,
  getProviderRetryIdentityLabel,
  resolveInferenceProviderRetryDelayMs,
} from '@roomote/types';

import {
  collectProviderErrorValues,
  extractProviderErrorHttpStatus,
} from './provider-error-recovery';

/** How many automatic continue attempts after a provider rate limit. */
export const DEFAULT_OPENCODE_RATE_LIMIT_MAX_RETRIES =
  INFERENCE_PROVIDER_MAX_RETRIES;

/** Base backoff before the first rate-limit continue prompt (ms). */
export const DEFAULT_OPENCODE_RATE_LIMIT_BASE_DELAY_MS =
  INFERENCE_PROVIDER_RATE_LIMIT_BASE_DELAY_MS;

/** Cap for exponential backoff between rate-limit continue prompts (ms). */
export const DEFAULT_OPENCODE_RATE_LIMIT_MAX_DELAY_MS =
  INFERENCE_PROVIDER_RATE_LIMIT_MAX_DELAY_MS;

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
  return resolveInferenceProviderRetryDelayMs({
    error: options.error,
    attemptNumber: options.attemptNumber,
    rateLimited: true,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs,
  });
}

export function formatOpenCodeRateLimitRetryNoticeText(options: {
  attemptNumber: number;
  maxAttempts: number;
  delayMs: number;
  errorSummary?: string;
  providerId?: string;
  modelId?: string;
}): string {
  const seconds = Math.max(1, Math.round(options.delayMs / 1000));
  const errorSummary = options.errorSummary?.trim();
  const headline = errorSummary
    ? `Provider rate limit: ${errorSummary}`
    : 'Provider rate limit hit';
  const attempt = `attempt ${options.attemptNumber}/${options.maxAttempts}`;
  const identity = getProviderRetryIdentityLabel(options);

  return `${headline}${identity ? ` for ${identity}` : ''}\n\nRetrying in ${seconds}s (${attempt}).`;
}
