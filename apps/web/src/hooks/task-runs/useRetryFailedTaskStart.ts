'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

export function useRetryFailedTaskStart(options?: {
  onSuccess?: (result: { runId: number; taskId: string }) => void;
  onError?: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.taskRuns.retryFailedStart.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.sandboxSession.byTaskId.queryKey(),
          });

          options?.onSuccess?.({
            runId: result.runId,
            taskId: result.taskId,
          });
        } else {
          toast.error('Oops', { description: result.error });
          options?.onError?.(new Error(result.error));
        }
      },
      onError: (error) => {
        toast.error('Oops', {
          description:
            error instanceof Error
              ? error.message
              : 'An unknown error occurred',
        });
        options?.onError?.(error);
      },
    }),
  );
}
