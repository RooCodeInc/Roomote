import { useQuery } from '@tanstack/react-query';

import type { TaskMessageEnvelope } from '@/types';

import { useTRPC } from '@/trpc/client';

export interface TaskMessageEnvelopesQueryState {
  data: TaskMessageEnvelope[] | undefined;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
}

export function useTaskMessageEnvelopes(
  taskId: string | null | undefined,
  options?: { enabled?: boolean },
): TaskMessageEnvelopesQueryState {
  const trpc = useTRPC();

  return useQuery(
    trpc.tasks.messageEnvelopes.queryOptions(
      { taskId: taskId ?? '' },
      { enabled: !!taskId && (options?.enabled ?? true) },
    ),
  );
}
