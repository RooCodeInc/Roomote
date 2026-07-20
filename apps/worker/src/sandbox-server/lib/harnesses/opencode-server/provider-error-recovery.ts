import { asFiniteNumber, asRecord, asString } from '@roomote/types';

const DEFAULT_OPENCODE_PROVIDER_ERROR_MAX_RETRIES = 3;
const DEFAULT_OPENCODE_POLICY_REFUSAL_MAX_RETRIES = 2;
export const DEFAULT_OPENCODE_PROVIDER_ERROR_BASE_DELAY_MS = 1_000;
export const DEFAULT_OPENCODE_PROVIDER_ERROR_MAX_DELAY_MS = 30_000;

const OPENCODE_PROVIDER_ERROR_RETRY_PROMPT_TEXT = [
  'Continue. The previous model request failed due to a provider error and was automatically retried.',
  'Resume from where you left off without restating the provider error.',
].join(' ');

const OPENCODE_POLICY_REFUSAL_RETRY_PROMPT_TEXT = [
  'Continue the legitimate task. The previous model request was declined by the provider safety policy.',
  'Do not attempt to bypass the policy or reproduce sensitive payloads, exploit strings, or operational instructions that may have triggered it.',
  'Use a high-level summary or safer abstraction where needed, then resume from where you left off.',
].join(' ');

export type OpenCodeProviderErrorRecovery = {
  kind: 'policy_refusal' | 'provider_error';
  maxRetries: number;
  promptText: string;
};

const POLICY_CODES = new Set([
  'cyber_policy',
  'content_policy',
  'content_policy_violation',
  'safety_policy',
]);

const TERMINAL_CODES = new Set([
  'account_suspended',
  'authentication_error',
  'billing_error',
  'context_length_exceeded',
  'credit_balance_too_low',
  'forbidden',
  'insufficient_balance',
  'insufficient_quota',
  'invalid_api_key',
  'invalid_model',
  'model_not_found',
  'payment_required',
  'permission_denied',
  'unauthorized',
]);

const TERMINAL_STATUS_CODES = new Set([400, 401, 402, 403, 404, 422]);

function collectProviderErrorValues(error: unknown): unknown[] {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const collected: unknown[] = [];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current || current.depth > 4) {
      continue;
    }

    const { value, depth } = current;
    collected.push(value);

    if (typeof value === 'string') {
      try {
        pending.push({ value: JSON.parse(value) as unknown, depth: depth + 1 });
      } catch {
        // Not JSON; the raw text is still useful for marker detection below.
      }
      continue;
    }

    if (!value || typeof value !== 'object' || seen.has(value)) {
      continue;
    }

    seen.add(value);

    for (const nested of Object.values(value)) {
      pending.push({ value: nested, depth: depth + 1 });
    }
  }

  return collected;
}

function normalizeCode(value: unknown): string | undefined {
  const code = asString(value)?.trim().toLowerCase();
  return code || undefined;
}

function isPolicyRefusal(values: unknown[]): boolean {
  for (const value of values) {
    const record = asRecord(value);
    const code = normalizeCode(record?.code);
    const name = normalizeCode(record?.name);

    if ((code && POLICY_CODES.has(code)) || name === 'contentfiltererror') {
      return true;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase();

      if (
        lower.includes('cyber_policy') ||
        lower.includes('content_policy_violation') ||
        lower.includes('flagged for possible cybersecurity risk') ||
        lower.includes("blocked by the provider's content filter") ||
        lower.includes('declined by the provider safety policy')
      ) {
        return true;
      }
    }
  }

  return false;
}

function isExplicitlyTerminal(values: unknown[]): boolean {
  for (const value of values) {
    const record = asRecord(value);

    if (record?.isRetryable === false) {
      return true;
    }

    const statusCode =
      asFiniteNumber(record?.statusCode) ?? asFiniteNumber(record?.status);

    if (statusCode !== undefined && TERMINAL_STATUS_CODES.has(statusCode)) {
      return true;
    }

    const code = normalizeCode(record?.code);

    if (code && TERMINAL_CODES.has(code)) {
      return true;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase();

      if (
        lower.includes('api key is missing') ||
        lower.includes('invalid api key') ||
        lower.includes('authentication failed') ||
        lower.includes('model is not available') ||
        lower.includes('model not found') ||
        lower.includes('maximum context length') ||
        lower.includes('insufficient balance') ||
        lower.includes('please recharge') ||
        (lower.includes('account') && lower.includes('is suspended')) ||
        lower.includes('payment required') ||
        lower.includes('insufficient quota')
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * OpenCode exposes errors it has decided to retry through session.status
 * before it emits a terminal session.error. Providers occasionally mark
 * billing or account failures as retryable, so the harness must be able to
 * override that decision before OpenCode enters an unbounded backoff loop.
 */
export function isOpenCodeTerminalProviderError(error: unknown): boolean {
  return isExplicitlyTerminal(collectProviderErrorValues(error));
}

/**
 * Provider session errors are recoverable by default because they normally
 * invalidate one model turn, not the OpenCode session or Roomote task. Keep a
 * small bounded retry budget, while explicit auth/configuration failures fail
 * immediately instead of burning requests that cannot succeed.
 */
export function getOpenCodeProviderErrorRecovery(
  error: unknown,
): OpenCodeProviderErrorRecovery | null {
  const values = collectProviderErrorValues(error);

  if (isPolicyRefusal(values)) {
    return {
      kind: 'policy_refusal',
      maxRetries: DEFAULT_OPENCODE_POLICY_REFUSAL_MAX_RETRIES,
      promptText: OPENCODE_POLICY_REFUSAL_RETRY_PROMPT_TEXT,
    };
  }

  if (isExplicitlyTerminal(values)) {
    return null;
  }

  return {
    kind: 'provider_error',
    maxRetries: DEFAULT_OPENCODE_PROVIDER_ERROR_MAX_RETRIES,
    promptText: OPENCODE_PROVIDER_ERROR_RETRY_PROMPT_TEXT,
  };
}

export function resolveOpenCodeProviderErrorRetryDelayMs(options: {
  attemptNumber: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}): number {
  const baseDelayMs = Math.max(
    1_000,
    options.baseDelayMs ?? DEFAULT_OPENCODE_PROVIDER_ERROR_BASE_DELAY_MS,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    options.maxDelayMs ?? DEFAULT_OPENCODE_PROVIDER_ERROR_MAX_DELAY_MS,
  );
  const attemptNumber = Math.max(1, options.attemptNumber);

  return Math.min(baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs);
}

const ERROR_SUMMARY_MAX_CHARS = 280;

/**
 * Prefer a short operator-facing provider message over raw OpenCode error
 * envelopes (status codes, headers, nested provider JSON).
 */
export function summarizeOpenCodeProviderError(error: unknown): string {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const messages: string[] = [];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current || current.depth > 4) {
      continue;
    }

    const { value, depth } = current;

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          pending.push({
            value: JSON.parse(trimmed) as unknown,
            depth: depth + 1,
          });
        } catch {
          // Ignore non-JSON blobs; only structured message fields below are used.
        }
      }

      continue;
    }

    if (!value || typeof value !== 'object' || seen.has(value)) {
      continue;
    }

    seen.add(value);
    const record = value as Record<string, unknown>;
    const messageCandidates = [
      record.message,
      record.error,
      record.data,
      record.cause,
    ];

    for (const candidate of messageCandidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();

        if (!trimmed) {
          continue;
        }

        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            pending.push({
              value: JSON.parse(trimmed) as unknown,
              depth: depth + 1,
            });
          } catch {
            // Keep the raw string if it is readable; JSON parsers already failed.
            if (trimmed.length > 8) {
              messages.push(trimmed);
            }
          }
          continue;
        }

        messages.push(trimmed);
        continue;
      }

      if (candidate && typeof candidate === 'object') {
        pending.push({ value: candidate, depth: depth + 1 });
      }
    }
  }

  const summary = messages
    .map((message) => message.replace(/\s+/gu, ' ').trim())
    .filter((message) => message.length > 0)
    // Prefer concrete messages over short tokens like "error".
    .sort((left, right) => right.length - left.length)[0];

  if (!summary) {
    return 'Unknown provider error';
  }

  if (summary.length <= ERROR_SUMMARY_MAX_CHARS) {
    return summary;
  }

  return `${summary.slice(0, ERROR_SUMMARY_MAX_CHARS - 1)}…`;
}

export function formatOpenCodeProviderErrorRetryNoticeText(options: {
  kind: OpenCodeProviderErrorRecovery['kind'] | 'opencode_retry';
  attemptNumber: number;
  maxAttempts: number;
  errorSummary?: string;
  delayMs?: number;
  showAttempt?: boolean;
}): string {
  const label =
    options.kind === 'policy_refusal'
      ? 'Provider safety refusal'
      : options.kind === 'opencode_retry'
        ? 'Provider error'
        : 'Provider error';
  const errorSummary = options.errorSummary?.trim();
  const headline = errorSummary ? `${label}: ${errorSummary}` : label;
  const showAttempt = options.showAttempt !== false;
  const attempt = showAttempt
    ? ` (attempt ${options.attemptNumber}/${options.maxAttempts})`
    : '';
  const delayMs = options.delayMs;

  const retryLine =
    delayMs !== undefined && delayMs > 0
      ? `Retrying in ${Math.max(1, Math.round(delayMs / 1000))}s${attempt}.`
      : `Retrying now${attempt}.`;

  return `${headline}\n\n${retryLine}`;
}
