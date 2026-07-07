import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useCreateTelegramLinkCode = () => {
  const trpc = useTRPC();

  return useMutation(
    trpc.linkedAccounts.createTelegramLinkCode.mutationOptions(),
  );
};
