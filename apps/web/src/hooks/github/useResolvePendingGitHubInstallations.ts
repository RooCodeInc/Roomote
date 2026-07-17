import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data = Awaited<
  ReturnType<
    ReturnType<
      typeof useTRPCClient
    >['github']['resolvePendingInstallations']['mutate']
  >
>;

type UseResolvePendingGitHubInstallationsOptions = Omit<
  UseMutationOptions<Data, Error>,
  'mutationFn'
>;

export const useResolvePendingGitHubInstallations = (
  options?: UseResolvePendingGitHubInstallationsOptions,
) => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => trpcClient.github.resolvePendingInstallations.mutate(),
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({
        queryKey: trpc.github.pendingInstallations.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.github.installations.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.sourceControl.repositories.queryKey(),
      });

      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
    ...options,
  });
};
