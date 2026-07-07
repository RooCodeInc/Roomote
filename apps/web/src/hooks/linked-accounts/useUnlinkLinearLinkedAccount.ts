import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useUnlinkLinearLinkedAccount = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.linkedAccounts.unlinkLinear.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.linkedAccounts.linear.queryKey(),
        });
      },
    }),
  );
};
