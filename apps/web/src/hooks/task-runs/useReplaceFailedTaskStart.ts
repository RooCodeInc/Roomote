'use client';

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

export function useReplaceFailedTaskStart(options?: {
  onSuccess?: (result: { runId: number; taskId: string }) => void;
}) {
  const trpc = useTRPC();

  return useMutation(
    trpc.taskRuns.replaceFailedStart.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          options?.onSuccess?.({ runId: result.id, taskId: result.taskId });
          return;
        }

        toast.error('Oops', { description: result.error });
      },
      onError: (error) => {
        toast.error('Oops', {
          description:
            error instanceof Error
              ? error.message
              : 'An unknown error occurred',
        });
      },
    }),
  );
}
