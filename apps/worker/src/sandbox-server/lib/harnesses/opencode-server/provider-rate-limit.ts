import { asFiniteNumber, asRecord, asString } from '@roomote/types';

/** How many automatic continue attempts after a provider rate limit. */
export const DEFAULT_OPENCODE_RATE_LIMIT_MAX_RETRIES = 3;

/** Base backoff before the first rate-limit continue prompt (ms). */
export const DEFAULT_OPENCODE_RATE_LIMIT_BASE_DELAY_MS = 5_000;

/** Cap for exponential backoff between rate-limit continue prompts (ms). */
export const DEFAULT_OPENCODE_RATE_LIMIT_MAX_DELAY_MS = 60_000;

export const OPENCODE_RATE_LIMIT_RETRY_PROMPT_SOURCE =
  'opencode-rate-limit-retry';

export const OPENCODE_RATE_LIMIT_RETRY_PROMPT_TEXT = [
  'Continue. The previous model request failed due to a temporary provider rate limit and was automatically retried.',
  'Resume from where you left off without restating the rate-limit error.',
].join(' ');

function collectRateLimitCandidateStrings(error: unknown): string[] {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  const values: unknown[] = [
    record?.message,
    data?.message,
    data?.responseBody,
    data?.body,
    // When OpenCode surfaces UnknownError, the message may already be a JSON
    // string of the provider payload; also keep the whole error serialized
    // as a final fallback for nested markers.
    typeof error === 'string' ? error : undefined,
  ];

  const strings: string[] = [];

  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      strings.push(value);
    }
  }

  return strings;
}

function objectIndicatesRateLimit(value: unknown): boolean {
  const record = asRecord(value);

  if (!record) {
    return false;
  }

  const code = record.code;
  if (code === 429 || code === '429') {
    return true;
  }

  if (typeof code === 'string' && code.toLowerCase().includes('rate_limit')) {
    return true;
  }

  const statusCode = asFiniteNumber(record.statusCode);
  if (statusCode === 429) {
    return true;
  }

  const metadata = asRecord(record.metadata);
  const errorType =
    asString(metadata?.error_type) ?? asString(record.error_type);
  if (
    errorType &&
    (errorType.toLowerCase().includes('rate_limit') ||
      errorType.toLowerCase() === 'too_many_requests')
  ) {
    return true;
  }

  const nestedError = asRecord(record.error);
  if (nestedError && objectIndicatesRateLimit(nestedError)) {
    return true;
  }

  return false;
}

/**
 * True when an OpenCode session.error payload is a provider rate limit
 * (HTTP 429 / rate_limit_exceeded / "too many requests"), including the
 * UnknownError-wrapped OpenRouter shape:
 * `{"code":429,"message":"Provider returned error","metadata":{"error_type":"rate_limit_exceeded"}}`
 *
 * OpenCode's own retry policy already covers APIError with isRetryable, but
 * that UnknownError payload falls through as a terminal session.error.
 */
export function isOpenCodeProviderRateLimitError(error: unknown): boolean {
  const record = asRecord(error);
  const data = asRecord(record?.data) ?? record;

  if (objectIndicatesRateLimit(data) || objectIndicatesRateLimit(record)) {
    return true;
  }

  for (const text of collectRateLimitCandidateStrings(error)) {
    const lower = text.toLowerCase();

    if (
      lower.includes('rate_limit') ||
      lower.includes('rate limit') ||
      lower.includes('too many requests') ||
      lower.includes('"error_type":"rate_limit_exceeded"') ||
      lower.includes('"code":429')
    ) {
      return true;
    }

    try {
      const parsed: unknown = JSON.parse(text);
      if (objectIndicatesRateLimit(parsed)) {
        return true;
      }
    } catch {
      // not JSON
    }
  }

  return false;
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
}): string {
  const seconds = Math.max(1, Math.round(options.delayMs / 1000));

  return `Provider rate limit hit; automatically retrying in about ${seconds}s (attempt ${options.attemptNumber}/${options.maxAttempts}).`;
}
