'use client';

import { GitPullRequest } from 'lucide-react';

import { cn } from '@/lib/utils';

interface PullRequestBadgeProps {
  repo: string;
  prNumber: number;
  url?: string;
  className?: string;
  iconClassName?: string;
}

export function PullRequestBadge({
  repo,
  prNumber,
  url,
  className,
  iconClassName,
}: PullRequestBadgeProps) {
  const pullRequestUrl = url ?? `https://github.com/${repo}/pull/${prNumber}`;
  const repoName = repo.split('/')[1] ?? repo;

  return (
    <a
      href={pullRequestUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1.5 cursor-pointer hover:underline',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <GitPullRequest
        className={cn('size-3.5 shrink-0', iconClassName)}
        strokeWidth={1.5}
      />
      <span className="truncate">
        {repoName}#{prNumber}
      </span>
    </a>
  );
}
