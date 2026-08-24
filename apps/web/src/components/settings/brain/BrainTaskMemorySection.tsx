'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MISSING_MEMORY_EVENT_COUNT_CAP } from '@roomote/types';
import { toast } from 'sonner';

import { Section } from '@/components/settings';
import {
  Button,
  CircleAlert,
  BookOpenText,
  Loader2,
  RefreshCw,
} from '@/components/system';
import { formatDistanceToNowCompact, formatNumber } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';

import type { BrainSettings } from '@/trpc/commands/brain';
import { buildMemorySegments } from './brain-presentation';

const MIN_SEGMENT_PERCENT = 1.5;

export function BrainTaskMemorySection({
  taskMemories,
}: {
  taskMemories: BrainSettings['taskMemories'];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const brainQueryKey = trpc.brain.get.queryKey();
  const segments = buildMemorySegments(taskMemories.byStatus).filter(
    (segment) => segment.count > 0,
  );

  const backfill = useMutation(
    trpc.brain.backfillTaskMemories.mutationOptions({
      onSuccess: ({ queued }) => {
        void queryClient.invalidateQueries({ queryKey: brainQueryKey });
        toast.success(
          queued === 0
            ? 'Every completed task already has a memory.'
            : `Queued ${formatNumber(queued)} completed tasks for the Brain.`,
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

  return (
    <Section
      icon={BookOpenText}
      title="Task memories"
      action={
        <span className="text-sm text-muted-foreground">
          {taskMemories.lastProcessedAt
            ? `Last processed ${formatDistanceToNowCompact(
                taskMemories.lastProcessedAt,
                { addSuffix: true },
              )}`
            : 'None recorded yet'}
        </span>
      }
    >
      <p className="text-sm text-muted-foreground">
        Every completed task owes the Brain a memory: what it decided, what it
        ruled out, and what a later task should not have to rediscover. The
        record is written after the run finishes, so nothing is lost if the
        Brain is briefly down.
      </p>

      {segments.length > 0 ? (
        <div className="space-y-3">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-background">
            {segments.map((segment) => (
              <div
                key={segment.id}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${Math.max(segment.percent, MIN_SEGMENT_PERCENT)}%`,
                  backgroundColor: segment.color,
                }}
              />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {segments.map((segment) => (
              <div key={segment.id} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: segment.color }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {segment.label}
                  </span>
                </div>
                <p className="text-lg font-semibold tabular-nums">
                  {formatNumber(segment.count)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {taskMemories.historicalCompletedRunsWithoutEvent > 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-background/50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>
            {formatNumber(taskMemories.historicalCompletedRunsWithoutEvent)}
            {taskMemories.historicalCompletedRunsWithoutEvent >=
            MISSING_MEMORY_EVENT_COUNT_CAP
              ? '+'
              : ''}{' '}
            completed tasks finished before the Brain was watching. Ingesting
            them gives agents that history.
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
            recent completed tasks were not queued for Brain memory.
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

      {taskMemories.byStatus.failed > 0 ? (
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
