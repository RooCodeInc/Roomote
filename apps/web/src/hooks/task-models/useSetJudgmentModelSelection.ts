'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useSetJudgmentModelSelection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.taskModels.judgment.setSelection.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.taskModels.judgment.get.queryKey(),
        }),
    }),
  );
}
