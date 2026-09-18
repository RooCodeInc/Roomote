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

export const useMarkRoomotePrReadyAfterCleanReview = () => {
  const trpc = useTRPC();

  return useQuery(
    trpc.sourceControl.markRoomotePrReadyAfterCleanReview.queryOptions(
      undefined,
    ),
  );
};

export const useSetMarkRoomotePrReadyAfterCleanReview = () => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enabled: boolean) =>
      trpcClient.sourceControl.setMarkRoomotePrReadyAfterCleanReview.mutate({
        enabled,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries(
        trpc.sourceControl.markRoomotePrReadyAfterCleanReview.queryFilter(),
      );
    },
  });
};

export const useGitHubRoomoteMention = () => {
  const trpc = useTRPC();

  return useQuery(
    trpc.sourceControl.githubRoomoteMention.queryOptions(undefined),
  );
};

export const useSetGitHubRoomoteMention = () => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enabled: boolean) =>
      trpcClient.sourceControl.setGitHubRoomoteMention.mutate({ enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries(
        trpc.sourceControl.githubRoomoteMention.queryFilter(),
      );
    },
  });
};
