'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

export function useCreateEnvironmentSnapshot() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.snapshots.createEnvironment.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.environments.list.queryKey(),
          });
        } else {
          toast.error('Oops', { description: result.error });
        }
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
