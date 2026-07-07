import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data =
  | { success: true; githubLogin: string }
  | { success: false; error: string };

type Variables = string;

type UseFinishAuthenticateGitHubAccountOptions = Omit<
  UseMutationOptions<Data, Error, Variables>,
  'mutationFn'
>;

export const useFinishAuthenticateGitHubAccount = (
  options?: UseFinishAuthenticateGitHubAccountOptions,
) => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const { onSuccess, ...restOptions } = options ?? {};

  return useMutation({
    mutationFn: (code) =>
      trpcClient.github.finishAuthenticateAccount.mutate({ code }),
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({
        queryKey: trpc.linkedAccounts.github.queryKey(),
      });

      onSuccess?.(data, variables, onMutateResult, context);
    },
    ...restOptions,
  });
};
