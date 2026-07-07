import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useUnlinkGitHubLinkedAccount = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.linkedAccounts.unlinkGitHub.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.linkedAccounts.github.queryKey(),
        });
      },
    }),
  );
};
