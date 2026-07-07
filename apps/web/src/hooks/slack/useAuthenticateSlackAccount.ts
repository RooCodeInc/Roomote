import { type UseMutationOptions, useMutation } from '@tanstack/react-query';

import { useTRPCClient } from '@/trpc/client';

type Data = { success: true; url: string } | { success: false; error: string };

type Variables = string | null;

type UseAuthenticateSlackAccountOptions = Omit<
  UseMutationOptions<Data, Error, Variables>,
  'mutationFn'
>;

export const useAuthenticateSlackAccount = (
  options?: UseAuthenticateSlackAccountOptions,
) => {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (redirect) =>
      trpcClient.slack.startAuthenticateAccount.mutate(
        redirect ? { state: { redirect } } : undefined,
      ),
    ...options,
  });
};
