'use client';

import type { ReactNode } from 'react';

import { Skeleton } from '@/components/system';
import { cn } from '@/lib/utils';

export function AnalyticsSummaryCardsGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('grid gap-0.5 md:grid-cols-2 xl:grid-cols-3', className)}
    >
      {children}
    </div>
  );
}

export function AnalyticsSummaryCard({
  label,
  value,
  secondary,
}: {
  label: string;
  value: string;
  secondary: string;
}) {
  return (
    <div className="bg-card gap-1 p-4">
      <p className="text-sm font-medium leading-snug text-muted-foreground">
        {label}
      </p>
      <div className="space-y-1 pt-0">
        <div className="text-2xl font-semibold leading-tight tracking-tight text-foreground md:text-3xl">
          {value}
        </div>
        <div className="text-sm text-muted-foreground">{secondary}</div>
      </div>
    </div>
  );
}

export function AnalyticsSummaryCardSkeleton() {
  return (
    <div className="bg-card p-4 space-y-2">
      <Skeleton className="h-4 w-28" />
      <div className="space-y-2 pt-0">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-20" />
      </div>
    </div>
  );
}
