'use client';

import Link from 'next/link';
import type { ComponentType } from 'react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import type { PullRequestStatus } from '@roomote/types';

import {
  ArrowRight,
  Badge,
  GitPullRequest,
  GitPullRequestCreateArrow,
  GitPullRequestDraft,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/system';
import { formatDistanceToNowCompact } from '@/lib';

type PullRequestsListProps = {
  enabled: boolean;
};

type PullRequestStatusFilter = 'all' | 'draft' | 'ready';

const STORAGE_KEY = 'home-pull-requests-status-filter';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All', icon: GitPullRequest },
  { value: 'draft', label: 'Draft', icon: GitPullRequestDraft },
  { value: 'ready', label: 'Ready', icon: GitPullRequestCreateArrow },
] satisfies Array<{
  value: PullRequestStatusFilter;
  label: string;
  icon: ComponentType<{ className?: string }>;
}>;

function readStoredStatusFilter(): PullRequestStatusFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'draft' || raw === 'ready' || raw === 'all' ? raw : 'all';
  } catch {
    return 'all';
  }
}

function writeStoredStatusFilter(value: PullRequestStatusFilter): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignore localStorage failures.
  }
}

function matchesFilter(
  status: PullRequestStatus | null,
  filter: PullRequestStatusFilter,
) {
  switch (filter) {
    case 'draft':
      return status === 'draft';
    case 'ready':
      return status === 'open';
    default:
      return true;
  }
}

function getStatusBadge(status: PullRequestStatus | null) {
  switch (status) {
    case 'draft':
      return {
        label: 'Draft',
        icon: GitPullRequestDraft,
      };
    case 'open':
      return {
        label: 'Ready',
        icon: GitPullRequestCreateArrow,
      };
    case 'merged':
      return {
        label: 'Merged',
        icon: GitPullRequest,
      };
    case 'closed':
      return {
        label: 'Closed',
        icon: GitPullRequest,
      };
    default:
      return null;
  }
}

export function PullRequestsList({ enabled }: PullRequestsListProps) {
  const trpc = useTRPC();
  const [statusFilter, setStatusFilter] = useState<PullRequestStatusFilter>(
    readStoredStatusFilter,
  );

  const pullRequestsQuery = useQuery(
    trpc.tasks.recentPullRequests.queryOptions(undefined, {
      enabled,
    }),
  );

  const pullRequests = pullRequestsQuery.data;
  const filteredPullRequests = useMemo(
    () =>
      (pullRequests ?? []).filter((pr) =>
        matchesFilter(pr.status ?? null, statusFilter),
      ),
    [pullRequests, statusFilter],
  );

  const onStatusFilterChange = (value: string) => {
    if (value !== 'all' && value !== 'draft' && value !== 'ready') {
      return;
    }

    setStatusFilter(value);
    writeStoredStatusFilter(value);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-20 bg-card">
        <Tabs
          value={statusFilter}
          onValueChange={onStatusFilterChange}
          className="gap-0"
        >
          <TabsList className="h-auto border-0 border-b-2 border-background w-full justify-start gap-0 rounded-none bg-transparent p-0 inset-shadow-none">
            {FILTER_OPTIONS.map((option) => {
              const Icon = option.icon;

              return (
                <TabsTrigger
                  key={option.value}
                  value={option.value}
                  className="h-8 flex-none gap-1.5 rounded-none border-none px-4 text-xs text-muted-foreground hover:text-accent-foreground! data-[state=active]:bg-foreground dark:data-[state=active]:text-accent-foreground dark:data-[state=active]:bg-accent-foreground dark:data-[state=active]:text-card data-[state=active]:shadow-none"
                >
                  <Icon className="size-3" />
                  {option.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>

      {pullRequestsQuery.isPending ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : filteredPullRequests.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {statusFilter === 'all'
            ? 'No recent pull requests. Yet.'
            : `No recent ${statusFilter} pull requests. Yet.`}
        </p>
      ) : (
        <ul className="divide-y divide-background">
          {filteredPullRequests.map((pr) => {
            const statusBadge = getStatusBadge(pr.status ?? null);

            return (
              <li key={`${pr.repo}#${pr.prNumber}`}>
                <div className="relative px-4 pt-3 pb-2 hover:bg-muted/40">
                  <a
                    href={pr.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open pull request ${pr.prTitle}`}
                    className="absolute inset-0 z-0"
                  />

                  <div className="relative z-10 flex items-center gap-3 pointer-events-none">
                    <p className="min-w-0 flex-1 truncate text-sm">
                      {pr.prTitle}
                    </p>

                    <Link
                      href={`/task/${pr.taskId}`}
                      className="pointer-events-auto relative z-20 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Task
                      <ArrowRight className="size-3" />
                    </Link>
                  </div>

                  <div className="relative z-10 mt-1 flex items-center gap-2 text-xs text-muted-foreground pointer-events-none">
                    <span className="font-mono text-xs">
                      {pr.repo}#{pr.prNumber}
                    </span>
                    {statusBadge ? (
                      <>
                        <span>·</span>
                        <Badge
                          variant="outline"
                          className="gap-2 items-center font-normal"
                        >
                          <statusBadge.icon className="size-3" />
                          {statusBadge.label}
                        </Badge>
                      </>
                    ) : null}
                    <span>·</span>
                    <span>
                      {formatDistanceToNowCompact(new Date(pr.createdAt), {
                        addSuffix: false,
                      })}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
