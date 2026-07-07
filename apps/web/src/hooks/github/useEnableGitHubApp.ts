import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Result =
  | { success: true; mode: 'synced' }
  | { success: true; mode: 'redirect'; url: string }
  | { success: false; error: string };

type Variables =
  | string
  | {
      redirect: string | null;
      callbackBackground?: 'accent' | 'background';
    }
  | null;

type UseEnableGitHubAppOptions = Omit<
  UseMutationOptions<Result, Error, Variables>,
  'mutationFn'
>;

export const useEnableGitHubApp = (options?: UseEnableGitHubAppOptions) => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables) => {
      const redirect =
        typeof variables === 'string' || variables == null
          ? variables
          : variables.redirect;
      const callbackBackground =
        typeof variables === 'string' || variables == null
          ? undefined
          : variables.callbackBackground;

      return trpcClient.github.enableApp.mutate(
        redirect || callbackBackground
          ? {
              state: {
                ...(redirect ? { redirect } : {}),
                ...(callbackBackground ? { bg: callbackBackground } : {}),
              },
            }
          : undefined,
      );
    },
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({
        queryKey: trpc.github.installations.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.sourceControl.repositories.queryKey(),
      });

      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: options?.onError,
  });
};
