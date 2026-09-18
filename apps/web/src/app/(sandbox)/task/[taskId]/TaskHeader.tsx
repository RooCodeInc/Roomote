'use client';

import { getTaskModelDisplayName, NO_REPOSITORIES } from '@roomote/types';
import type { ReactNode } from 'react';

import {
  ModelBadge,
  PullRequestBadge,
  WorkspaceBadge,
} from '@/components/sandbox';
import { TaskRobotIcon } from '@/components/tasks/TaskRobotIcon';
import { cn } from '@/lib/utils';

export function TaskTitle({
  taskId,
  title,
  sessionId,
  orderedTaskIds,
  prefix,
  showIcon = true,
  className,
}: {
  taskId: string;
  title: string;
  sessionId?: string | null;
  orderedTaskIds?: string[];
  prefix?: string;
  showIcon?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {showIcon ? (
        <TaskRobotIcon
          taskId={taskId}
          sessionId={sessionId}
          orderedTaskIds={orderedTaskIds}
        />
      ) : null}
      {prefix ? <span className="shrink-0 font-semibold">{prefix}</span> : null}
      <span className="min-w-0 truncate">{title}</span>
    </span>
  );
}

export function TaskHeaderContent({
  taskId,
  sessionId,
  orderedTaskIds,
  showIcon = true,
  children,
}: {
  taskId: string;
  sessionId?: string | null;
  orderedTaskIds?: string[];
  showIcon?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      {showIcon ? (
        <TaskRobotIcon
          taskId={taskId}
          sessionId={sessionId}
          orderedTaskIds={orderedTaskIds}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0">{children}</div>
    </div>
  );
}

export function TaskHeaderMetadata({
  model,
  environmentId,
  repo,
  pullRequests = [],
  prRepo,
  prNumber,
  className,
}: {
  model?: string | null;
  environmentId?: string;
  repo?: string;
  pullRequests?: Array<{
    repository: string;
    prNumber: number;
    prUrl?: string;
  }>;
  prRepo?: string | null;
  prNumber?: number | null;
  className?: string;
}) {
  const hasPullRequest = pullRequests.length > 0 || (prRepo && prNumber);
  const hasWorkspace =
    environmentId !== NO_REPOSITORIES &&
    repo !== NO_REPOSITORIES &&
    Boolean(environmentId || repo);

  if (!model && !hasWorkspace && !hasPullRequest) return null;

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground',
        className,
      )}
    >
      {model ? (
        <ModelBadge
          model={model}
          displayName={getTaskModelDisplayName(model)}
          showIcon={false}
          iconClassName="text-muted-foreground"
        />
      ) : null}
      {hasWorkspace ? (
        <WorkspaceBadge
          environmentId={environmentId}
          repo={repo}
          iconClassName="text-muted-foreground"
        />
      ) : null}
      {pullRequests.map((pullRequest) => (
        <PullRequestBadge
          key={`${pullRequest.repository}:${pullRequest.prNumber}`}
          repo={pullRequest.repository}
          prNumber={pullRequest.prNumber}
          url={pullRequest.prUrl}
          iconClassName="text-muted-foreground"
        />
      ))}
      {pullRequests.length === 0 && prRepo && prNumber ? (
        <PullRequestBadge
          repo={prRepo}
          prNumber={prNumber}
          iconClassName="text-muted-foreground"
        />
      ) : null}
    </div>
  );
}
