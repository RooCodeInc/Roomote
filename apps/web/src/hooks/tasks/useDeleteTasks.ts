import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

type Options = {
  onSuccess?: (data: { success: true; deletedCount: number }) => void;
  onError?: (error: unknown) => void;
};

export const useDeleteTasks = ({ onSuccess, onError }: Options = {}) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.tasks.delete.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: trpc.tasks.list.queryKey() });
        onSuccess?.(data);
      },
      onError,
    }),
  );
};
