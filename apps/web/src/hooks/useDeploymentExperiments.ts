'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  DeploymentExperimentId,
  DeploymentExperimentValues,
} from '@roomote/feature-flags';
import { getDeploymentExperimentValues } from '@roomote/feature-flags';

import { useTRPC } from '@/trpc/client';

type MutationContext = {
  previous: DeploymentExperimentValues;
  optimistic: DeploymentExperimentValues;
};

export function useDeploymentExperiments(errorMessage?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.deploymentExperiments.get.queryKey();
  const query = useQuery(trpc.deploymentExperiments.get.queryOptions());
  const experiments = query.data as DeploymentExperimentValues | undefined;
  const mutation = useMutation(
    trpc.deploymentExperiments.set.mutationOptions({
      onMutate: async (variables): Promise<MutationContext> => {
        await queryClient.cancelQueries({ queryKey });
        const previous =
          queryClient.getQueryData<DeploymentExperimentValues>(queryKey) ??
          experiments ??
          getDeploymentExperimentValues(undefined);
        const optimistic = { ...previous, [variables.id]: variables.enabled };
        queryClient.setQueryData(queryKey, optimistic);
        return { previous, optimistic };
      },
      onSuccess: (result, variables) => {
        queryClient.setQueryData<DeploymentExperimentValues>(
          queryKey,
          (current) => ({
            ...(current ?? result),
            [variables.id]: result[variables.id],
          }),
        );
      },
      onError: (_error, variables, context) => {
        queryClient.setQueryData<DeploymentExperimentValues>(
          queryKey,
          (current) => {
            if (!current || !context) return context?.previous ?? current;
            return current[variables.id] === context.optimistic[variables.id]
              ? { ...current, [variables.id]: context.previous[variables.id] }
              : current;
          },
        );
        if (errorMessage) toast.error(errorMessage);
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey });
      },
    }),
  );

  return {
    experiments,
    error: query.error,
    hasLoadedExperiments: experiments !== undefined,
    isFetching: query.isFetching,
    isLoading: query.isPending,
    isUpdating: mutation.isPending,
    refetch: query.refetch,
    setExperiment: (id: DeploymentExperimentId, enabled: boolean) =>
      mutation.mutate({ id, enabled }),
  };
}

export function useDeploymentExperiment(
  id: DeploymentExperimentId,
  errorMessage: string,
) {
  const state = useDeploymentExperiments(errorMessage);
  return {
    enabled: state.experiments?.[id] === true,
    isLoading: state.isLoading,
    isUpdating: state.isUpdating,
    setEnabled: (enabled: boolean) => state.setExperiment(id, enabled),
  };
}
