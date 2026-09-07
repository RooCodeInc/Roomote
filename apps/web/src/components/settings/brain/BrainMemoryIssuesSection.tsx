'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MISSING_MEMORY_EVENT_COUNT_CAP } from '@roomote/types';
import { toast } from 'sonner';

import { Section } from '@/components/settings';
import {
  Button,
  CircleAlert,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from '@/components/system';
import { formatNumber } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';

import type { BrainSettings } from '@/trpc/commands/brain';

export function BrainMemoryIssuesSection({
  taskMemories,
}: {
  taskMemories: BrainSettings['taskMemories'];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const brainQueryKey = trpc.brain.get.queryKey();
  const hasMissingMemories =
    taskMemories.historicalCompletedRunsWithoutEvent > 0 ||
    taskMemories.recentCompletedRunsWithoutEvent > 0;
  const hasFailedMemories = taskMemories.byStatus.failed > 0;

  const backfill = useMutation(
    trpc.brain.backfillTaskMemories.mutationOptions({
      onSuccess: ({ queued }) => {
        void queryClient.invalidateQueries({ queryKey: brainQueryKey });
        toast.success(
          queued === 0
            ? 'Every completed task already has a memory.'
            : `Queued ${formatNumber(queued)} completed tasks for Memory.`,
        );
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const retryFailed = useMutation(
    trpc.brain.retryFailedTaskMemories.mutationOptions({
      onSuccess: ({ requeued }) => {
        void queryClient.invalidateQueries({ queryKey: brainQueryKey });
        toast.success(
          `Requeued ${formatNumber(requeued)} memories for another attempt.`,
        );
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (!hasMissingMemories && !hasFailedMemories) {
    return null;
  }

  return (
    <Section icon={TriangleAlert} title="Memory issues">
      {taskMemories.historicalCompletedRunsWithoutEvent > 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-background/50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>
            {formatNumber(taskMemories.historicalCompletedRunsWithoutEvent)}
            {taskMemories.historicalCompletedRunsWithoutEvent >=
            MISSING_MEMORY_EVENT_COUNT_CAP
              ? '+'
              : ''}{' '}
            completed tasks finished before Memory was watching. Ingesting them
            gives agents that history.
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={backfill.isPending}
            onClick={() => backfill.mutate()}
          >
            {backfill.isPending ? <Loader2 className="animate-spin" /> : null}
            Ingest task history
          </Button>
        </div>
      ) : null}

      {taskMemories.recentCompletedRunsWithoutEvent > 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <CircleAlert className="size-4 text-destructive" />
            {formatNumber(taskMemories.recentCompletedRunsWithoutEvent)}
            {taskMemories.recentCompletedRunsWithoutEvent >=
            MISSING_MEMORY_EVENT_COUNT_CAP
              ? '+'
              : ''}{' '}
            recent completed tasks were not queued for Memory.
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={backfill.isPending}
            onClick={() => backfill.mutate()}
          >
            {backfill.isPending ? <Loader2 className="animate-spin" /> : null}
            Queue missing memories
          </Button>
        </div>
      ) : null}

      {hasFailedMemories ? (
        <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2">
              <CircleAlert className="size-4 text-destructive" />
              {formatNumber(taskMemories.byStatus.failed)} memories exhausted
              their attempts.
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={retryFailed.isPending}
              onClick={() => retryFailed.mutate()}
            >
              {retryFailed.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              Retry failed
            </Button>
          </div>
          {taskMemories.lastError ? (
            <p className="break-words font-mono text-xs text-muted-foreground">
              {taskMemories.lastError}
            </p>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
