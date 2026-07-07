'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

export function useRestoreCloudJobSnapshot(options?: {
  onSuccess?: (result: { cloudJobId: number; taskId: string }) => void;
  onError?: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.snapshots.restoreCloudJob.mutationOptions({
      onSuccess: (result, _variables) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.sandboxSession.byTaskId.queryKey(),
          });

          if ('cloudJobId' in result) {
            options?.onSuccess?.({
              cloudJobId: result.cloudJobId,
              taskId: result.taskId,
            });
          }
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
