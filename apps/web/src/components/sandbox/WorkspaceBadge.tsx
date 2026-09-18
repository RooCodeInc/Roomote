'use client';

import type { LucideIcon } from '@/components/system';
import { BookCopy, BookMarked, VectorSquare } from '@/components/system';

import { ALL_REPOSITORIES } from '@roomote/types';

import { cn } from '@/lib/utils';

import { useEnvironment } from '@/hooks/environments';

interface WorkspaceBadgeProps {
  environmentId?: string;
  repo?: string;
  fallbackLabel?: string;
  className?: string;
  iconClassName?: string;
  showIcon?: boolean;
  size?: 'xs' | 'sm';
}

const BADGE_SIZES = {
  xs: { icon: 'size-3', gap: 'gap-1' },
  sm: { icon: 'size-3.5', gap: 'gap-1.5' },
} as const;

function useWorkspaceSelection(
  environmentId?: string,
  repo?: string,
  fallbackLabel?: string,
): { icon: LucideIcon; label: string } | null {
  const environment = useEnvironment(environmentId);

  if (environmentId) {
    return {
      icon: VectorSquare,
      label: environment.data?.name ?? fallbackLabel ?? '',
    };
  }

  if (repo === ALL_REPOSITORIES) {
    return { icon: BookCopy, label: 'All repositories' };
  }

  if (repo) {
    const shortName = repo.includes('/') ? repo.split('/').pop()! : repo;
    return { icon: BookMarked, label: shortName };
  }

  return null;
}

export function WorkspaceBadge({
  environmentId,
  repo,
  fallbackLabel,
  className,
  iconClassName,
  showIcon = true,
  size = 'sm',
}: WorkspaceBadgeProps) {
  const selection = useWorkspaceSelection(environmentId, repo, fallbackLabel);

  if (!selection) {
    return null;
  }

  const { icon: Icon, label } = selection;

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
        <Icon
          className={cn(BADGE_SIZES[size].icon, 'shrink-0', iconClassName)}
        />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}
