import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from '@/hooks/mcp-connections';

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
      void invalidateMcpIntegrationStatusQueries(queryClient, trpc);
      queryClient.invalidateQueries({
        queryKey: trpc.linear.installation.queryKey(),
      });
      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: options?.onError,
  });
};
