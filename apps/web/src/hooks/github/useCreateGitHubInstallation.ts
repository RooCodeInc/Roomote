import { type UseMutationOptions, useMutation } from '@tanstack/react-query';

import { useTRPCClient } from '@/trpc/client';

type Data = { success: true; url: string } | { success: false; error: string };

type Variables = string | null;

type UseCreateGitHubInstallationOptions = Omit<
  UseMutationOptions<Data, Error, Variables>,
  'mutationFn'
>;

export const useCreateGitHubInstallation = (
  options?: UseCreateGitHubInstallationOptions,
) => {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (redirect) =>
      trpcClient.github.startCreateInstallation.mutate(
        redirect ? { state: { redirect } } : undefined,
      ),
    ...options,
  });
};
