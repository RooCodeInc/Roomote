import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data = { success: true } | { success: false; error: string };

type Variables = { taskId: string; runId?: number };

type Options = Omit<UseMutationOptions<Data, Error, Variables>, 'mutationFn'>;

export const useCancelTaskRun = ({ onSuccess, ...options }: Options = {}) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (variables) => trpcClient.taskRuns.cancel.mutate(variables),
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({ queryKey: trpc.tasks.list.queryKey() });
      onSuccess?.(data, variables, onMutateResult, context);
    },
    ...options,
  });
};
