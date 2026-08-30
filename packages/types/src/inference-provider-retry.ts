import { asFiniteNumber, asRecord, asString } from './primitives';

export const INFERENCE_PROVIDER_MAX_RETRIES = 3;
export const INFERENCE_PROVIDER_ERROR_BASE_DELAY_MS = 1_000;
export const INFERENCE_PROVIDER_ERROR_MAX_DELAY_MS = 30_000;
export const INFERENCE_PROVIDER_RATE_LIMIT_BASE_DELAY_MS = 5_000;
export const INFERENCE_PROVIDER_RATE_LIMIT_MAX_DELAY_MS = 60_000;

export function buildInferenceProviderRecoveryPrompt(
  options: { protectCompletedSideEffects?: boolean } = {},
): string {
  return [
    'Continue. The previous model request failed due to a provider error and was automatically retried.',
    'Resume from where you left off without restating the provider error.',
    options.protectCompletedSideEffects
      ? 'Do not repeat completed tool calls or messages already sent to the user.'
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

function findResponseHeaders(
  error: unknown,
): Record<string, unknown> | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 4) continue;

    const { value, depth } = current;
    if (typeof value === 'string') {
      try {
        pending.push({ value: JSON.parse(value), depth: depth + 1 });
      } catch {
        // Provider prose cannot contain structured retry headers.
      }
      continue;
    }

    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);

    const record = asRecord(value);
    const responseHeaders = asRecord(record?.responseHeaders);
    if (responseHeaders) {
      return Object.fromEntries(
        Object.entries(responseHeaders).map(([key, headerValue]) => [
          key.toLowerCase(),
          headerValue,
        ]),
      );
    }

    for (const nested of Object.values(record ?? {})) {
      pending.push({ value: nested, depth: depth + 1 });
    }
  }

  return undefined;
}

export function resolveInferenceProviderRetryDelayMs(options: {
  error?: unknown;
  attemptNumber: number;
  rateLimited: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
}): number {
  const defaultBaseDelayMs = options.rateLimited
    ? INFERENCE_PROVIDER_RATE_LIMIT_BASE_DELAY_MS
    : INFERENCE_PROVIDER_ERROR_BASE_DELAY_MS;
  const defaultMaxDelayMs = options.rateLimited
    ? INFERENCE_PROVIDER_RATE_LIMIT_MAX_DELAY_MS
    : INFERENCE_PROVIDER_ERROR_MAX_DELAY_MS;
  const baseDelayMs = Math.max(
    options.rateLimited ? 0 : 1_000,
    options.baseDelayMs ?? defaultBaseDelayMs,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    options.maxDelayMs ?? defaultMaxDelayMs,
  );

  if (options.rateLimited) {
    const headers = findResponseHeaders(options.error);
    if (headers) {
      const retryAfterMs = asFiniteNumber(headers['retry-after-ms']);
      if (retryAfterMs !== undefined && retryAfterMs >= 0) {
        return Math.min(retryAfterMs, maxDelayMs);
      }

      const retryAfter = asString(headers['retry-after']);
      if (retryAfter) {
        const asSeconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
          return Math.min(Math.ceil(asSeconds * 1_000), maxDelayMs);
        }

        const asDateMs = Date.parse(retryAfter) - Date.now();
        if (!Number.isNaN(asDateMs) && asDateMs > 0) {
          return Math.min(Math.ceil(asDateMs), maxDelayMs);
        }
      }
    }
  }

  const attemptNumber = Math.max(1, options.attemptNumber);
  return Math.min(baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs);
}
