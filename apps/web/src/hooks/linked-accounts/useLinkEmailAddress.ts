import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useLinkEmailAddress = () => {
  const trpc = useTRPC();

  return useMutation(trpc.linkedAccounts.linkEmailAddress.mutationOptions());
};
