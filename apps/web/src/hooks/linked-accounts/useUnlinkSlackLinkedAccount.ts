import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useUnlinkSlackLinkedAccount = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.linkedAccounts.unlinkSlack.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.linkedAccounts.slack.queryKey(),
        });
      },
    }),
  );
};
