import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data = Awaited<
  ReturnType<
    ReturnType<typeof useTRPCClient>['github']['syncInstallations']['mutate']
  >
>;

type UseSyncGitHubInstallationsOptions = Omit<
  UseMutationOptions<Data, Error>,
  'mutationFn'
>;

export const useSyncGitHubInstallations = (
  options?: UseSyncGitHubInstallationsOptions,
) => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => trpcClient.github.syncInstallations.mutate(),
    onSuccess: (data, variables, onMutateResult, context) => {
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
