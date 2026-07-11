import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskRunDetail } from '@/lib/server';

import { useTRPC } from '@/trpc/client';

import { parseSleepDeadlineMs } from './sleep-deadline';

/**
 * Watches the server-provided sleep expiry and triggers an immediate
 * invalidation of the `sandboxSession.byTaskId` query when that deadline is
 * reached. This closes the polling gap without requiring the server to stream
 * countdown ticks every second.
 */
export function useSleepInvalidation(taskRun?: TaskRunDetail | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const taskId = taskRun?.taskId;
  const sleepDeadlineMs = parseSleepDeadlineMs(taskRun?.sleepAt);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInvalidatedExpiryRef = useRef<number | null>(null);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (sleepDeadlineMs == null) {
      return;
    }

    const invalidate = () => {
      if (lastInvalidatedExpiryRef.current === sleepDeadlineMs) {
        return;
      }

      lastInvalidatedExpiryRef.current = sleepDeadlineMs;
      queryClient.invalidateQueries({
        queryKey: trpc.sandboxSession.byTaskId.queryKey({ taskId: taskId! }),
      });
    };

    const remainingMs = sleepDeadlineMs - Date.now();

    if (remainingMs <= 0) {
      invalidate();
      return;
    }

    timeoutRef.current = setTimeout(invalidate, remainingMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [sleepDeadlineMs, queryClient, taskId, trpc]);
}
