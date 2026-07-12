'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

export function useCreateTaskRunSnapshot(options?: {
  onSuccess?: (result: { success: true }) => void;
  onError?: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.snapshots.createTaskRun.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.sandboxSession.byTaskId.queryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: trpc.tasks.list.queryKey(),
          });
          options?.onSuccess?.({ success: true });
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
