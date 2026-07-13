import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useCreateDiscordLinkCode = () => {
  const trpc = useTRPC();

  return useMutation(
    trpc.linkedAccounts.createDiscordLinkCode.mutationOptions(),
  );
};
