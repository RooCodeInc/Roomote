import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';
import { invalidateMcpIntegrationStatusQueries } from '@/hooks/mcp-connections';

type UseDisconnectLinearOptions = Omit<
  UseMutationOptions<void, Error, void>,
  'mutationFn'
>;

export const useDisconnectLinear = (options?: UseDisconnectLinearOptions) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: async () => {
      const result = await trpcClient.mcpConnections.disconnect.mutate({
        mcpId: 'linear',
        role: 'linear_org_install',
      });

      if (!result.success) {
        throw new Error('Failed to disconnect Linear');
      }
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
