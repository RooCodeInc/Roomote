import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useUnlinkTelegramLinkedAccount = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.linkedAccounts.unlinkTelegram.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.linkedAccounts.telegram.queryKey(),
        });
      },
    }),
  );
};
