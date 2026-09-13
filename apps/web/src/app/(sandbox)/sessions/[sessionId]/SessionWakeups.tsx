'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/system';
import { useTRPC, useTRPCClient } from '@/trpc/client';

import { SessionWakeupList } from './SessionWakeupList';

export function SessionWakeups({ sessionId }: { sessionId: string }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const queryKey = trpc.sessions.wakeups.queryKey({ sessionId });
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await client.sessions.wakeups.query(
        { sessionId },
        { signal },
      );
      return { ...result, clockOffsetMs: Date.parse(result.now) - Date.now() };
    },
    // Quiet wakeups do not publish assistant messages. Discover new schedules
    // and advance fired occurrences independently of the transcript.
    refetchInterval: 10_000,
    refetchOnWindowFocus: 'always',
  });

  const cancel = async (wakeupId: string) => {
    try {
      await client.sessions.cancelWakeup.mutate({ sessionId, wakeupId });
      // All returned outcomes mean this ID is no longer active in this session.
      queryClient.setQueryData(
        queryKey,
        (previous) =>
          previous && {
            ...previous,
            wakeups: previous.wakeups.filter(
              (wakeup) => wakeup.id !== wakeupId,
            ),
          },
      );
    } finally {
      await queryClient.invalidateQueries({ queryKey });
    }
  };

  return (
    <>
      {query.data && (
        <SessionWakeupList
          wakeups={query.data.wakeups}
          clockOffsetMs={query.data.clockOffsetMs}
          canCancel={query.data.canCancel}
          onCancel={cancel}
          onDue={() => void query.refetch()}
        />
      )}
      {query.isError && (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-1 text-xs text-muted-foreground"
        >
          Could not refresh scheduled timers.
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
    </>
  );
}
