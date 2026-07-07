import { type UseMutationOptions, useMutation } from '@tanstack/react-query';

import { useTRPCClient } from '@/trpc/client';

type Data = { success: true; url: string } | { success: false; error: string };

type GitHubCallbackBackground = 'accent' | 'background';

type Variables =
  | string
  | {
      redirect?: string | null;
      callbackBackground?: GitHubCallbackBackground;
    }
  | null;

type UseAuthenticateGitHubAccountOptions = Omit<
  UseMutationOptions<Data, Error, Variables>,
  'mutationFn'
>;

export const useAuthenticateGitHubAccount = (
  options?: UseAuthenticateGitHubAccountOptions,
) => {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (variables) => {
      const redirect =
        typeof variables === 'string' ? variables : variables?.redirect;
      const callbackBackground =
        typeof variables === 'string'
          ? undefined
          : variables?.callbackBackground;

      if (!redirect && !callbackBackground) {
        return trpcClient.github.startAuthenticateAccount.mutate();
      }

      return trpcClient.github.startAuthenticateAccount.mutate({
        state: {
          ...(redirect ? { redirect } : {}),
          ...(callbackBackground ? { bg: callbackBackground } : {}),
        },
      });
    },
    ...options,
  });
};
