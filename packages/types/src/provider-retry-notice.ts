import { asBoolean, asFiniteNumber, asRecord, asString } from './primitives';

export const PROVIDER_RETRY_NOTICE_PAYLOAD_KEY = 'providerRetryNotice' as const;

export type ProviderRetryNoticeKind =
  | 'provider_error'
  | 'policy_refusal'
  | 'rate_limit'
  | 'opencode_retry';

export type ProviderRetryNotice = {
  kind: ProviderRetryNoticeKind;
  attemptNumber: number;
  maxAttempts: number;
  /**
   * When false, the UI shows a bare "Retrying..." status instead of attempt
   * counters (OpenCode internal retries do not expose a fixed budget).
   */
  showAttempt?: boolean;
  /**
   * Backoff before the next automatic retry. Omitted when the harness retries
   * as soon as the failed turn reaches idle.
   */
  delayMs?: number;
  /**
   * Absolute wall-clock deadline used by the UI countdown. Preferred over
   * delayMs alone so mid-stream reconnects still show accurate remaining time.
   */
  retryAtMs?: number;
  /** Short human-readable provider error, without the retry instruction. */
  errorSummary?: string;
};

export function isProviderRetryNoticeKind(
  value: unknown,
): value is ProviderRetryNoticeKind {
  return (
    value === 'provider_error' ||
    value === 'policy_refusal' ||
    value === 'rate_limit' ||
    value === 'opencode_retry'
  );
}

export function parseProviderRetryNotice(
  value: unknown,
): ProviderRetryNotice | null {
  const record = asRecord(value);

  if (!record || !isProviderRetryNoticeKind(record.kind)) {
    return null;
  }

  const attemptNumber = asFiniteNumber(record.attemptNumber);
  const maxAttempts = asFiniteNumber(record.maxAttempts);

  if (
    attemptNumber === undefined ||
    maxAttempts === undefined ||
    attemptNumber < 1 ||
    maxAttempts < 1
  ) {
    return null;
  }

  const delayMs = asFiniteNumber(record.delayMs);
  const retryAtMs = asFiniteNumber(record.retryAtMs);
  const errorSummary = asString(record.errorSummary)?.trim();
  const showAttempt = asBoolean(record.showAttempt);

  return {
    kind: record.kind,
    attemptNumber: Math.trunc(attemptNumber),
    maxAttempts: Math.trunc(maxAttempts),
    ...(showAttempt === false ? { showAttempt: false } : {}),
    ...(delayMs !== undefined && delayMs >= 0
      ? { delayMs: Math.trunc(delayMs) }
      : {}),
    ...(retryAtMs !== undefined && retryAtMs > 0
      ? { retryAtMs: Math.trunc(retryAtMs) }
      : {}),
    ...(errorSummary && errorSummary.length > 0 ? { errorSummary } : {}),
  };
}

export function getProviderRetryNoticeFromMessageData(
  data: Record<string, unknown> | null | undefined,
): ProviderRetryNotice | null {
  if (!data) {
    return null;
  }

  return parseProviderRetryNotice(data[PROVIDER_RETRY_NOTICE_PAYLOAD_KEY]);
}
