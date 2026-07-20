'use client';

import type {
  SubscriptionProviderUsage,
  SubscriptionUsageWindow,
} from '@roomote/types';

import { Progress } from '@/components/system';
import { cn } from '@/lib/utils';

function formatUsageReset(resetsAt: string): string | null {
  const reset = new Date(resetsAt).getTime();

  if (Number.isNaN(reset)) {
    return null;
  }

  const deltaMinutes = Math.round((reset - Date.now()) / 60_000);

  if (deltaMinutes <= 0) {
    return null;
  }
  if (deltaMinutes < 60) {
    return `resets in ${deltaMinutes}m`;
  }
  if (deltaMinutes < 48 * 60) {
    return `resets in ${Math.round(deltaMinutes / 60)}h`;
  }

  return `resets ${new Date(reset).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
}

function formatUsageWindow(window: SubscriptionUsageWindow): string | null {
  let value: string;

  if (window.unlimited) {
    value = 'unlimited';
  } else if (window.remaining !== undefined && window.limit !== undefined) {
    value = `${window.remaining.toLocaleString()} of ${window.limit.toLocaleString()} left`;
  } else if (window.used !== undefined && window.limit !== undefined) {
    value = `${window.used.toLocaleString()} of ${window.limit.toLocaleString()} used`;
  } else if (window.usedPercent !== undefined) {
    value = `${Math.round(window.usedPercent)}% used`;
  } else {
    return null;
  }

  const reset =
    !window.unlimited && window.resetsAt
      ? formatUsageReset(window.resetsAt)
      : null;

  return `${window.label}: ${value}${reset ? ` (${reset})` : ''}`;
}

function getUsageWindowPercent(
  window: SubscriptionUsageWindow,
): number | undefined {
  if (window.unlimited) {
    return undefined;
  }

  if (window.usedPercent !== undefined && Number.isFinite(window.usedPercent)) {
    return Math.max(0, Math.min(100, window.usedPercent));
  }

  if (
    window.limit !== undefined &&
    window.limit > 0 &&
    window.remaining !== undefined &&
    Number.isFinite(window.remaining)
  ) {
    return Math.max(
      0,
      Math.min(100, ((window.limit - window.remaining) / window.limit) * 100),
    );
  }

  if (
    window.limit !== undefined &&
    window.limit > 0 &&
    window.used !== undefined &&
    Number.isFinite(window.used)
  ) {
    return Math.max(0, Math.min(100, (window.used / window.limit) * 100));
  }

  return undefined;
}

function usageBarClassName(usedPercent: number): string {
  if (usedPercent >= 90) {
    return 'bg-destructive';
  }
  if (usedPercent >= 75) {
    return 'bg-warning';
  }
  return 'bg-foreground/45';
}

export function SubscriptionUsageLine({
  usage,
  className,
}: {
  usage: SubscriptionProviderUsage | undefined;
  className?: string;
}) {
  const rows = (usage?.windows ?? [])
    .map((window) => {
      const label = formatUsageWindow(window);
      if (!label) {
        return null;
      }

      return {
        key: window.label,
        label,
        usedPercent: getUsageWindowPercent(window),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      {rows.map((row) => (
        <div key={row.key} className="min-w-0 space-y-1">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {row.label}
          </p>
          {row.usedPercent !== undefined ? (
            <Progress
              value={row.usedPercent}
              className="h-1.5 bg-muted"
              barClassName={usageBarClassName(row.usedPercent)}
              aria-label={`${row.key} usage`}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
