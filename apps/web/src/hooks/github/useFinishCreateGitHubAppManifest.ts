import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data =
  | { success: true; installUrl: string }
  | { success: false; error: string };

type Variables = string;

type UseFinishCreateGitHubAppManifestOptions = Omit<
  UseMutationOptions<Data, Error, Variables>,
  'mutationFn'
>;

export const useFinishCreateGitHubAppManifest = (
  options?: UseFinishCreateGitHubAppManifestOptions,
) => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (code) =>
      trpcClient.github.finishCreateAppManifest.mutate({ code }),
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
