import { useEffect, useState } from 'react';
import {
  getProviderRetryNoticeFromMessageData,
  type ProviderRetryNotice,
} from '@roomote/types';

import { RefreshCw } from '@/components/system';

function getRetryTitle(notice: ProviderRetryNotice): string {
  switch (notice.kind) {
    case 'rate_limit':
      return 'Provider rate limit';
    case 'policy_refusal':
      return 'Provider safety refusal';
    case 'opencode_retry':
      return 'Provider retry';
    default:
      return 'Provider error';
  }
}

function formatRemainingSeconds(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function useRetryCountdown(retryAtMs: number | undefined): number | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(() => {
    if (retryAtMs === undefined) {
      return null;
    }

    return Math.max(0, retryAtMs - Date.now());
  });

  useEffect(() => {
    if (retryAtMs === undefined) {
      setRemainingMs(null);
      return;
    }

    const tick = () => {
      setRemainingMs(Math.max(0, retryAtMs - Date.now()));
    };

    tick();
    const intervalId = window.setInterval(tick, 250);
    return () => window.clearInterval(intervalId);
  }, [retryAtMs]);

  return remainingMs;
}

function getRetryingStatusText(options: {
  notice: ProviderRetryNotice;
  remainingMs: number | null;
}): string {
  const showAttempt = options.notice.showAttempt !== false;
  const attempt = showAttempt
    ? ` (attempt ${options.notice.attemptNumber}/${options.notice.maxAttempts})`
    : '';

  if (options.remainingMs !== null && options.remainingMs > 0) {
    return `Retrying in ${formatRemainingSeconds(options.remainingMs)}s${attempt}`;
  }

  if (options.remainingMs === 0) {
    return `Retrying now${attempt}`;
  }

  if (options.notice.delayMs !== undefined && options.notice.delayMs > 0) {
    return `Retrying in ${formatRemainingSeconds(options.notice.delayMs)}s${attempt}`;
  }

  return `Retrying now${attempt}`;
}

export function ProviderRetryNoticeMessage({
  data,
}: {
  data: Record<string, unknown>;
  text: string;
}) {
  const notice = getProviderRetryNoticeFromMessageData(data);
  // Hooks must run unconditionally even when this component is not mounted
  // for a retry notice (the parent already gates, but keep the component
  // safe if message data transitions).
  const remainingMs = useRetryCountdown(notice?.retryAtMs);

  if (!notice) {
    return null;
  }

  const errorText = notice.errorSummary?.trim() ?? '';
  const statusText = getRetryingStatusText({ notice, remainingMs });
  const isCountingDown = remainingMs !== null && remainingMs > 0;

  return (
    <div
      className="max-w-2xl rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm"
      data-testid="provider-retry-notice"
      role="status"
    >
      <div className="flex items-start gap-2">
        <RefreshCw
          className={`mt-0.5 size-4 shrink-0 text-muted-foreground ${
            isCountingDown ? 'animate-spin' : ''
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium" data-testid="provider-retry-notice-title">
            {getRetryTitle(notice)}
          </p>
          {errorText ? (
            <p
              className="mt-1 whitespace-pre-wrap break-words text-muted-foreground"
              data-testid="provider-retry-notice-error"
            >
              {errorText}
            </p>
          ) : null}
          <p
            className="mt-1 text-muted-foreground"
            data-testid="provider-retry-notice-status"
          >
            {statusText}
          </p>
        </div>
      </div>
    </div>
  );
}
