'use client';

import { useQuery } from '@tanstack/react-query';

import { Bot, ChevronRight, Skeleton } from '@/components/system';
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
        refetchInterval: (query) => query.state.data?.refetchInterval ?? 2_000,
      },
    ),
  );
  const title = data?.task?.title?.trim() || prompt || 'Delegated task';

  return (
    <button
      type="button"
      className="group my-2 flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50"
      onClick={() => onOpen(taskId)}
      aria-label={`View delegated task: ${title}`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted-foreground">
          Delegated task
        </span>
        {isPending ? (
          <Skeleton className="mt-1 h-4 w-2/3" />
        ) : (
          <span className="ph-no-capture block truncate text-sm font-medium">
            {title}
          </span>
        )}
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
