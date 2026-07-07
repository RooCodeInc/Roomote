import type * as React from 'react';

import { cn } from '@/lib/utils';

type FramedSurfaceVariant = 'basic' | 'bold';

const frameClasses: Record<FramedSurfaceVariant, string> = {
  basic: 'bg-card',
  bold: 'bg-white',
};

const surfaceClasses: Record<FramedSurfaceVariant, string> = {
  basic: 'bg-background',
  bold: 'light bg-accent-bright-foreground text-foreground',
};

type FramedSurfaceProps = React.ComponentProps<'div'> & {
  variant?: FramedSurfaceVariant;
  frameClassName?: string;
  surfaceClassName?: string;
};

export function FramedSurface({
  children,
  frameClassName,
  variant = 'basic',
  surfaceClassName,
  ...props
}: FramedSurfaceProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 w-full p-2 flex-1',
        frameClasses[variant],
        frameClassName,
      )}
      {...props}
    >
      <div
        className={cn(
          'flex h-full min-h-0 min-w-0 w-full flex-1 rounded-3xl overflow-clip ',
          surfaceClasses[variant],
          surfaceClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
