import { useEffect, useState } from 'react';
import {
  getProviderRetryIdentityLabel,
  getProviderRetryNoticeFromMessageData,
  type ProviderRetryNotice,
} from '@roomote/types';

import { Button, RefreshCw } from '@/components/system';
import { useProviderRetryModelSwitcher } from '@/lib/provider-retry-model-switcher';
import { cn } from '@/lib/utils';

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
  const openModelSwitcher = useProviderRetryModelSwitcher();

  if (!notice) {
    return null;
  }

  const errorText = notice.errorSummary?.trim() ?? '';
  const identityText = getProviderRetryIdentityLabel(notice);
  const statusText = getRetryingStatusText({ notice, remainingMs });
  const isCountingDown = remainingMs !== null && remainingMs > 0;
  const hasDetails = Boolean(errorText) || Boolean(statusText);

  return (
    <div
      className="w-full min-w-0 text-sm text-muted-foreground"
      data-testid="provider-retry-notice"
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2 py-1">
        <span className="relative flex size-3 shrink-0 items-center justify-center">
          <RefreshCw
            className={cn('size-3', isCountingDown && 'animate-spin')}
          />
        </span>
        <span
          className="min-w-0 truncate font-light"
          data-testid="provider-retry-notice-title"
        >
          {getRetryTitle(notice)}
        </span>
      </div>
      {hasDetails ? (
        <div className="space-y-1 border-l border-border px-4 ml-1.5 mb-1 mt-1 text-sm font-light">
          {errorText ? (
            <p
              className="whitespace-pre-wrap break-words"
              data-testid="provider-retry-notice-error"
            >
              {errorText}
            </p>
          ) : null}
          {identityText ? (
            <p data-testid="provider-retry-notice-identity">
              Using {identityText}
            </p>
          ) : null}
          <p data-testid="provider-retry-notice-status">{statusText}</p>
          {notice.kind === 'rate_limit' && openModelSwitcher ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1 h-7"
              data-testid="provider-retry-switch-model"
              onClick={openModelSwitcher}
            >
              Switch model
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
