'use client';

import type * as React from 'react';

import { cn } from '@/lib/utils';

type ProgressProps = React.ComponentProps<'div'> & {
  barClassName?: string;
  value?: number;
};

function Progress({
  className,
  barClassName = '',
  value = 0,
  ...props
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div
      data-slot="progress"
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-background',
        className,
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          'h-full w-full flex-1 bg-primary transition-all',
          barClassName,
        )}
        style={{ transform: `translateX(-${100 - clamped}%)` }}
      />
    </div>
  );
}

export { Progress };
