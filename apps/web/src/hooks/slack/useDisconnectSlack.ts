import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Result = { success: true };

type UseDisconnectSlackOptions = Omit<
  UseMutationOptions<Result, Error, void>,
  'mutationFn'
>;

export const useDisconnectSlack = (options?: UseDisconnectSlackOptions) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: async () => {
      const result = await trpcClient.slack.disconnectApp.mutate();

      if (!result.success) {
        throw new Error(result.error);
      }

      return result;
    },
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({
        queryKey: trpc.slack.installation.queryKey(),
      });

      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: options?.onError,
  });
};
