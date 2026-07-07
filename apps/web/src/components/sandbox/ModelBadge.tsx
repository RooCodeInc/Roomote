'use client';

import { Brain } from '@/components/system';

import { cn } from '@/lib/utils';

interface ModelBadgeProps {
  model?: string | null;
  displayName?: string | null;
  className?: string;
  iconClassName?: string;
}

export function ModelBadge({
  model,
  displayName,
  className,
  iconClassName,
}: ModelBadgeProps) {
  const label = displayName?.trim() || model || '';

  if (label.length === 0) {
    return null;
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Brain className={cn('size-3.5 shrink-0', iconClassName)} />
      <span className="truncate">{label}</span>
    </span>
  );
}
