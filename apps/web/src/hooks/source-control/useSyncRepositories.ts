import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { SourceControlTokenBackedProvider } from '@roomote/types';

import { useTRPC, useTRPCClient } from '@/trpc/client';

type Data = Awaited<
  ReturnType<
    ReturnType<
      typeof useTRPCClient
    >['sourceControl']['syncRepositories']['mutate']
  >
>;

type UseSyncRepositoriesOptions = Omit<
  UseMutationOptions<Data, Error>,
  'mutationFn'
>;

export const useSyncRepositories = (
  provider: SourceControlTokenBackedProvider,
  options?: UseSyncRepositoriesOptions,
) => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      trpcClient.sourceControl.syncRepositories.mutate({ provider }),
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.invalidateQueries({
        queryKey: trpc.sourceControl.repositories.queryKey(),
      });

      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: options?.onError,
  });
};
