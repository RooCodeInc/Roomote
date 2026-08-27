import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { FramedSurface } from './FramedSurface';

type WorkspaceSurfaceProps = React.ComponentProps<'div'> & {
  sideActions?: ReactNode;
  frameClassName?: string;
  surfaceClassName?: string;
};

export function WorkspaceSurface({
  children,
  className,
  sideActions,
  frameClassName,
  surfaceClassName,
  ...props
}: WorkspaceSurfaceProps) {
  return (
    <div
      className={cn('flex h-full min-h-0 min-w-0 flex-1 bg-card', className)}
      {...props}
    >
      <FramedSurface
        frameClassName={cn('pb-0 md:pb-2', frameClassName)}
        surfaceClassName={cn(
          'flex flex-col bg-transparent @container',
          surfaceClassName,
        )}
      >
        {children}
      </FramedSurface>
      {sideActions}
    </div>
  );
}
