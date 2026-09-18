'use client';

import { type CSSProperties, type ElementType, memo } from 'react';

import { cn } from '@/lib/utils';

interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = 'div',
  className,
  spread = 2,
}: TextShimmerProps) => {
  return (
    <Component
      className={cn('relative inline-block text-shimmer', className)}
      style={{ '--spread': `${children.length * spread}px` } as CSSProperties}
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
