import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data =
  | { success: true; installUrl: string }
  | { success: false; error: string };

type Variables =
  | string
  | {
      code: string;
      redirect?: string | null;
    };

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
    mutationFn: (variables) => {
      const code = typeof variables === 'string' ? variables : variables.code;
      const redirect =
        typeof variables === 'string'
          ? undefined
          : variables.redirect?.trim() || undefined;

      return trpcClient.github.finishCreateAppManifest.mutate({
        code,
        ...(redirect ? { redirect } : {}),
      });
    },
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({
        queryKey: trpc.github.installations.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.sourceControl.repositories.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.sourceControl.configStatus.queryKey(),
      });

      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
    ...options,
  });
};
