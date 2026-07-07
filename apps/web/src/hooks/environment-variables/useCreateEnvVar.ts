'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useCreateEnvVar() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.environmentVariables.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.environmentVariables.list.queryKey(),
        });
      },
    }),
  );
}
