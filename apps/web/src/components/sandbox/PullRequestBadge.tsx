'use client';

import { GitPullRequest } from 'lucide-react';

import { cn } from '@/lib/utils';

interface PullRequestBadgeProps {
  repo: string;
  prNumber: number;
  url?: string;
  className?: string;
  iconClassName?: string;
  showIcon?: boolean;
  size?: 'xs' | 'sm';
}

const BADGE_SIZES = {
  xs: { icon: 'size-3', gap: 'gap-1' },
  sm: { icon: 'size-3.5', gap: 'gap-1.5' },
} as const;

export function PullRequestBadge({
  repo,
  prNumber,
  url,
  className,
  iconClassName,
  showIcon = true,
  size = 'sm',
}: PullRequestBadgeProps) {
  const pullRequestUrl = url ?? `https://github.com/${repo}/pull/${prNumber}`;
  const repoName = repo.split('/')[1] ?? repo;

  return (
    <a
      href={pullRequestUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex cursor-pointer items-center hover:underline',
        BADGE_SIZES[size].gap,
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {showIcon ? (
        <GitPullRequest
          className={cn(BADGE_SIZES[size].icon, 'shrink-0', iconClassName)}
          strokeWidth={1.5}
        />
      ) : null}
      <span className="truncate">
        {repoName}#{prNumber}
      </span>
    </a>
  );
}
