'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useDeleteEnvVar() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.environmentVariables.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.environmentVariables.list.queryKey(),
        });
      },
    }),
  );
}
