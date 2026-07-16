import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useUnlinkDiscordLinkedAccount = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.linkedAccounts.unlinkDiscord.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.linkedAccounts.discord.queryKey(),
        });
      },
    }),
  );
};
