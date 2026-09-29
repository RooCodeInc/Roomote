'use client';

import { GitPullRequest } from 'lucide-react';

import { cn } from '@/lib/utils';

interface PullRequestBadgeProps {
  repo?: string | null;
  prNumber?: number | null;
  url?: string;
  title?: string | null;
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
  title,
  className,
  iconClassName,
  showIcon = true,
  size = 'sm',
}: PullRequestBadgeProps) {
  const hasReference = Boolean(
    repo && prNumber !== null && prNumber !== undefined,
  );
  const pullRequestUrl =
    url ??
    (hasReference ? `https://github.com/${repo}/pull/${prNumber}` : null);
  if (!pullRequestUrl) return null;

  const repoName = repo?.split('/')[1] ?? repo;
  const label = hasReference
    ? `${repoName}#${prNumber}`
    : title || 'Pull request';

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
      <span className="truncate">{label}</span>
    </a>
  );
}
