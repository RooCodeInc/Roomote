import { type UseMutationOptions, useMutation } from '@tanstack/react-query';

import { useTRPCClient } from '@/trpc/client';

type Data =
  | {
      success: true;
      postTarget: string;
      values: {
        manifest: string;
      };
    }
  | { success: false; error: string };

type Variables =
  | string
  | {
      redirect: string | null;
      organization?: string | null;
    }
  | null;

type UseCreateGitHubAppManifestOptions = Omit<
  UseMutationOptions<Data, Error, Variables>,
  'mutationFn'
>;

export const useCreateGitHubAppManifest = (
  options?: UseCreateGitHubAppManifestOptions,
) => {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (variables) => {
      const redirect =
        typeof variables === 'string' || variables == null
          ? variables
          : variables.redirect;
      const organization =
        typeof variables === 'string' || variables == null
          ? null
          : (variables.organization?.trim() ?? null);

      return trpcClient.github.startCreateAppManifest.mutate({
        state: {
          mode: 'github-app-manifest',
          ...(redirect ? { redirect } : {}),
        },
        ...(organization ? { organization } : {}),
      });
    },
    ...options,
  });
};
