'use client';

import { Brain } from '@/components/system';

import { cn } from '@/lib/utils';

interface ModelBadgeProps {
  model?: string | null;
  displayName?: string | null;
  className?: string;
  iconClassName?: string;
  showIcon?: boolean;
  size?: 'xs' | 'sm';
}

const BADGE_SIZES = {
  xs: { icon: 'size-3', gap: 'gap-1' },
  sm: { icon: 'size-3.5', gap: 'gap-1.5' },
} as const;

export function ModelBadge({
  model,
  displayName,
  className,
  iconClassName,
  showIcon = true,
  size = 'sm',
}: ModelBadgeProps) {
  const label = displayName?.trim() || model || '';

  if (label.length === 0) {
    return null;
  }

  return (
    <span
      className={cn(
        'inline-flex cursor-default items-center',
        BADGE_SIZES[size].gap,
        className,
      )}
    >
      {showIcon ? (
        <Brain
          className={cn(BADGE_SIZES[size].icon, 'shrink-0', iconClassName)}
        />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}
