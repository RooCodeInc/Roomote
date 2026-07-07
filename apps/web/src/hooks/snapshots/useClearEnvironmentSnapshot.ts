'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

export function useClearEnvironmentSnapshot() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.snapshots.clearEnvironment.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.environments.list.queryKey(),
          });

          toast.success('Snapshot Cleared', {
            description:
              'You can now create a new snapshot for this environment.',
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
