'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useDeleteTypeSafeKey() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.taskModels.judgment.deleteTypeSafeKey.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.taskModels.judgment.get.queryKey(),
        }),
    }),
  );
}
