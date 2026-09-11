'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { activeRunStatuses, isExitedRunStatus } from '@roomote/types';

import {
  BasicTooltip,
  ChevronRight,
  Skeleton,
  SquareIcon,
} from '@/components/system';
import { TaskStatusIndicator } from '@/components/sandbox';
import { TaskRobotIcon } from '@/components/tasks/TaskRobotIcon';
import { useTRPC } from '@/trpc/client';
import { useCancelTaskRun } from '@/hooks/task-runs/useCancelTaskRun';
import { cn } from '@/lib/utils';

export function DelegatedTaskCard({
  taskId,
  prompt,
  onOpen,
}: {
  taskId: string;
  prompt: string | null;
  onOpen: (taskId: string) => void;
}) {
  const trpc = useTRPC();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const { data, isPending, refetch } = useQuery(
    trpc.sandboxSession.byTaskId.queryOptions(
      { taskId },
      {
        // The server only supplies refetchInterval during startup/snapshot
        // fast-poll phases; its absence is NOT a settled signal. Keep polling
        // until the run actually exits, then stop.
        refetchInterval: (query) => {
          const data = query.state.data;
          if (data?.refetchInterval) return data.refetchInterval;
          return data && isExitedRunStatus(data.taskRun?.status)
            ? false
            : 2_000;
        },
      },
    ),
  );
  const title = data?.task?.title?.trim() || prompt || 'Delegated task';
  const isCodeReviewTask = data?.task?.workflow === 'pr_review';
  const taskLabel = isCodeReviewTask ? 'Code review agent' : 'Coding agent';
  const agentDescription = isCodeReviewTask
    ? 'code review task'
    : 'coding task';
  const cancel = useCancelTaskRun({
    onSuccess: (result) => {
      if (result.success) {
        setCancelError(null);
        void refetch();
      } else {
        setCancelError(result.error);
      }
    },
    onError: (error) => setCancelError(error.message),
  });
  // byTaskId only returns a run to callers with execution access.
  const canStop =
    !!data?.taskRun &&
    activeRunStatuses.some((status) => status === data.taskRun.status);

  return (
    <div className="my-2">
      <div className="relative">
        <button
          type="button"
          className="group flex w-full cursor-pointer items-center gap-3 rounded-xl bg-card px-4 py-3 text-left hover:bg-card/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen(taskId)}
          aria-label={`View ${agentDescription}: ${title}`}
        >
          <span className="relative shrink-0">
            <TaskRobotIcon taskId={taskId} size="sm" />
            <TaskStatusIndicator
              compact
              status={data?.taskRun?.status ?? null}
              phase={
                isExitedRunStatus(data?.taskRun?.status)
                  ? null
                  : (data?.taskRun?.taskPhase ?? null)
              }
              lastErrorMessage={data?.taskRun?.error ?? null}
              className="absolute top-0 right-0 rounded-full ring-2 ring-card"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground group-hover:text-accent-foreground">
              {taskLabel}
            </span>
            {isPending ? (
              <Skeleton className="mt-1 h-4 w-2/3" />
            ) : (
              <span className="ph-no-capture block truncate text-sm font-medium group-hover:text-accent-foreground">
                {title}
              </span>
            )}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5',
              canStop && 'ml-8',
            )}
          />
        </button>
        {canStop && (
          <BasicTooltip content={`Stop ${agentDescription}`}>
            <button
              type="button"
              aria-label={`Stop ${agentDescription}`}
              aria-busy={cancel.isPending}
              disabled={cancel.isPending}
              className="absolute top-1/2 right-10 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-chart-4 hover:text-chart-4/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!data?.taskRun || !canStop || cancel.isPending) return;
                setCancelError(null);
                cancel.mutate({
                  taskId,
                  runId: data.taskRun.id,
                  terminate: false,
                });
              }}
            >
              <SquareIcon
                aria-hidden="true"
                className="size-3.5 fill-current"
              />
            </button>
          </BasicTooltip>
        )}
      </div>
      {cancelError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {cancelError}
        </p>
      )}
    </div>
  );
}
