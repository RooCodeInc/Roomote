'use client';

import type { ProviderCreditBalance } from '@roomote/types';

import { Progress } from '@/components/system';
import { cn } from '@/lib/utils';

function formatMoney(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function getUsedPercent(balance: ProviderCreditBalance): number | undefined {
  if (
    balance.limit === undefined ||
    balance.limit <= 0 ||
    balance.remaining === undefined ||
    !Number.isFinite(balance.remaining)
  ) {
    return undefined;
  }

  return Math.max(
    0,
    Math.min(100, ((balance.limit - balance.remaining) / balance.limit) * 100),
  );
}

function barClassName(usedPercent: number): string {
  if (usedPercent >= 90) {
    return 'bg-destructive';
  }
  if (usedPercent >= 75) {
    return 'bg-warning';
  }
  return 'bg-foreground/45';
}

export function ProviderCreditBalanceLine({
  balance,
  className,
}: {
  balance: ProviderCreditBalance | undefined;
  className?: string;
}) {
  if (!balance || balance.remaining === undefined) {
    return null;
  }

  const currency = balance.currency ?? 'USD';
  const remainingLabel = formatMoney(balance.remaining, currency);
  const label =
    balance.limit !== undefined
      ? `${remainingLabel} of ${formatMoney(balance.limit, currency)} left`
      : `${remainingLabel} left`;

  const usedPercent = getUsedPercent(balance);

  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      {usedPercent !== undefined ? (
        <Progress
          value={usedPercent}
          className="h-2 bg-muted"
          barClassName={barClassName(usedPercent)}
          aria-label="Credit balance"
        />
      ) : null}
      <p className="min-w-0 truncate text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
