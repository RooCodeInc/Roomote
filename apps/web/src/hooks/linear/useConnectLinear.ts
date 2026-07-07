import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type UseConnectLinearOptions = Omit<
  UseMutationOptions<string, Error, void>,
  'mutationFn'
>;

export const useConnectLinear = (
  redirectPath?: string,
  options?: UseConnectLinearOptions,
) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: async () => {
      return trpcClient.mcpConnections.connect.mutate({
        mcpId: 'linear',
        role: 'linear_org_install',
        ...(redirectPath ? { redirectTo: redirectPath } : {}),
      });
    },
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({
        queryKey: trpc.linear.installation.queryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.mcpConnections.deploymentEnablements.queryKey(),
      });

      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: options?.onError,
  });
};
