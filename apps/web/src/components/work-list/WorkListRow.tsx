'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';

import { formatInferenceCost } from '@/lib';
import { cn } from '@/lib/utils';
import {
  DollarSign,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';

export function WorkListRow({
  href,
  ariaLabel,
  leading,
  leadingOverlay,
  actor,
  activityLabel,
  activityAdornment,
  activityDate,
  title,
  description,
  metadata,
  selected = false,
  interactive = true,
  nativeLink = false,
}: {
  href: string;
  ariaLabel: string;
  leading: ReactNode;
  leadingOverlay?: ReactNode;
  actor: ReactNode;
  activityLabel: string;
  activityAdornment?: ReactNode;
  activityDate: Date;
  title: ReactNode;
  description?: ReactNode;
  metadata: ReactNode;
  selected?: boolean;
  interactive?: boolean;
  nativeLink?: boolean;
}) {
  const router = useRouter();
  const className = cn(
    'ph-no-capture group relative flex w-full items-start gap-3 p-4',
    selected && 'bg-foreground/20',
    interactive &&
      'cursor-pointer transition-colors hover:bg-accent-foreground/10',
    nativeLink &&
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  );

  const content = (
    <>
      <div className="relative z-20 mt-1 flex h-8 w-12 shrink-0 justify-center">
        {leading}
        {leadingOverlay}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground/75 md:items-center">
          <div className="flex flex-wrap items-center gap-1 text-nowrap">
            <span className="ph-no-capture">{actor}</span>
            <span>{activityLabel}</span>
            {activityAdornment}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <time
                dateTime={activityDate.toISOString()}
                className="relative z-20 shrink-0 cursor-default whitespace-nowrap"
              >
                {formatDistanceToNow(activityDate, { addSuffix: true })}
              </time>
            </TooltipTrigger>
            <TooltipContent>{activityDate.toLocaleString()}</TooltipContent>
          </Tooltip>
        </div>

        {interactive ? (
          <p className="ph-no-capture mt-1 mb-2 line-clamp-2 text-lg leading-tight text-foreground group-hover:underline">
            {title}
          </p>
        ) : (
          <Link
            href={href}
            className="block"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="ph-no-capture mt-1 mb-2 line-clamp-2 text-lg leading-tight text-foreground hover:underline">
              {title}
            </p>
          </Link>
        )}

        {description ? <div className="mb-2">{description}</div> : null}

        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden text-xs text-muted-foreground">
          {metadata}
        </div>
      </div>
    </>
  );

  if (nativeLink && interactive) {
    return (
      <Link href={href} aria-label={ariaLabel} className={className}>
        {content}
      </Link>
    );
  }

  return (
    <div
      className={className}
      onClick={(event) => {
        if (
          interactive &&
          event.target instanceof Element &&
          !event.target.closest('a')
        ) {
          router.push(href);
        }
      }}
    >
      {interactive ? (
        <Link
          href={href}
          aria-label={ariaLabel}
          className="absolute inset-0 z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        />
      ) : null}
      {content}
    </div>
  );
}

export function WorkListInferenceCost({
  costMicroUsd,
}: {
  costMicroUsd?: number | null;
}) {
  const label = formatInferenceCost(costMicroUsd);

  if (Number(label) <= 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative z-20 inline-flex cursor-default items-center gap-1 text-nowrap">
          <DollarSign className="size-3 shrink-0" />
          <span>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Inference cost</TooltipContent>
    </Tooltip>
  );
}

export function WorkListRowSkeleton({ count = 6 }: { count?: number }) {
  const titleWidths = ['50%', '45%', '40%', '35%'] as const;

  return (
    <div className="w-full divide-y divide-card">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="relative flex w-full items-start gap-3 p-4">
          <div className="relative mt-1 flex h-8 w-12 shrink-0 justify-center">
            <Skeleton className="size-8 rounded-full" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-2 md:items-center">
              <div className="flex flex-wrap items-center gap-1">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-3 w-20 shrink-0" />
            </div>
            <div className="mt-1 mb-2 max-w-xl space-y-1.5">
              <Skeleton
                className="h-5"
                style={{ width: titleWidths[index % titleWidths.length] }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-28 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
