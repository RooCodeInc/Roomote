import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type UseConnectSlackOptions = Omit<
  UseMutationOptions<string, Error, void>,
  'mutationFn'
>;

export const useConnectSlack = (
  redirectPath?: string,
  options?: UseConnectSlackOptions,
) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: async () => {
      const result = await trpcClient.slack.connectApp.mutate({
        redirectPath,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      return result.url;
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
