import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data = Awaited<
  ReturnType<
    ReturnType<typeof useTRPCClient>['github']['syncInstallation']['mutate']
  >
>;

type Variables = number;

type UseSyncGitHubInstallationOptions = Omit<
  UseMutationOptions<Data, Error, Variables>,
  'mutationFn'
>;

export const useSyncGitHubInstallation = (
  options?: UseSyncGitHubInstallationOptions,
) => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    ...options,
    mutationFn: (installationId) =>
      trpcClient.github.syncInstallation.mutate({ installationId }),
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.removeQueries({
        queryKey: trpc.setup.status.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.github.installations.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.sourceControl.repositories.queryKey(),
      });

      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  });
};
