'use client';

import { useQuery } from '@tanstack/react-query';

import { isExitedRunStatus } from '@roomote/types';

import { ChevronRight, Skeleton } from '@/components/system';
import { TaskStatusIndicator } from '@/components/sandbox';
import { useTRPC } from '@/trpc/client';

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
  const { data, isPending } = useQuery(
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
  // Latest assistant activity for the in-flight run (server clears it once
  // the run exits); the plain status indicator remains the fallback.
  const activityLine = data?.activityLine ?? null;

  return (
    <button
      type="button"
      className="group my-2 flex w-full cursor-pointer items-center gap-3 rounded-xl bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50"
      onClick={() => onOpen(taskId)}
      aria-label={`View coding task: ${title}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted-foreground">
          Started coding task
        </span>
        {isPending ? (
          <Skeleton className="mt-1 h-4 w-2/3" />
        ) : (
          <span className="ph-no-capture block truncate text-sm font-medium">
            {title}
          </span>
        )}
        {!isPending && activityLine ? (
          <span className="ph-no-capture mt-0.5 block truncate text-xs text-muted-foreground">
            {activityLine}
          </span>
        ) : null}
      </span>
      <TaskStatusIndicator
        status={data?.taskRun?.status ?? null}
        phase={data?.taskRun?.taskPhase ?? null}
        lastErrorMessage={data?.taskRun?.error ?? null}
        labelClassName="inline"
      />
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
