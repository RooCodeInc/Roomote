import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrAction } from '@roomote/types';

import { useTRPC, useTRPCClient } from '@/trpc/client';

export const usePrAction = () => {
  const trpc = useTRPC();

  return useQuery(trpc.sourceControl.prAction.queryOptions(undefined));
};

export const useSetPrAction = () => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (prAction: PrAction) =>
      trpcClient.sourceControl.setPrAction.mutate({ prAction }),
    onSuccess: () => {
      void queryClient.invalidateQueries(
        trpc.sourceControl.prAction.queryFilter(),
      );
    },
  });
};
