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
}

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
    return { icon: BookCopy, label: 'All Repos' };
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
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Icon className={cn('size-3.5 shrink-0', iconClassName)} />
      <span className="truncate">{label}</span>
    </span>
  );
}
