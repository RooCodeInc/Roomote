'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  DeploymentExperimentAudience,
  DeploymentExperimentId,
  DeploymentExperimentRuntimeId,
  DeploymentExperimentValues,
} from '@roomote/feature-flags';
import {
  getDeploymentExperimentAudience,
  getDeploymentExperimentValues,
  isDeploymentExperimentRuntimeReadable,
} from '@roomote/feature-flags';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

type MutationContext = {
  previous: Partial<DeploymentExperimentValues>;
  optimistic: Partial<DeploymentExperimentValues>;
};

export function useDeploymentExperiments(
  errorMessage?: string,
  audience: 'customer-preview' | 'internal-nightly' = 'customer-preview',
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isNightly = audience === 'internal-nightly';
  const queryKey = isNightly
    ? trpc.nightlyExperiments.get.queryKey()
    : trpc.deploymentExperiments.get.queryKey();
  const query = useQuery(
    isNightly
      ? trpc.nightlyExperiments.get.queryOptions()
      : trpc.deploymentExperiments.get.queryOptions(),
  );
  const experiments = query.data;

  const mutationLifecycle = {
    onMutate: async (variables: {
      id: DeploymentExperimentId;
      enabled: boolean;
    }): Promise<MutationContext> => {
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Partial<DeploymentExperimentValues>>(
          queryKey,
        ) ??
        experiments ??
        getDeploymentExperimentValues(undefined);
      const optimistic = { ...previous, [variables.id]: variables.enabled };
      queryClient.setQueryData(queryKey, optimistic);
      return { previous, optimistic };
    },
    onSuccess: (
      result: Partial<DeploymentExperimentValues>,
      variables: { id: DeploymentExperimentId; enabled: boolean },
    ) => {
      queryClient.setQueryData<Partial<DeploymentExperimentValues>>(
        queryKey,
        (current) => ({
          ...(current ?? result),
          [variables.id]: result[variables.id],
        }),
      );
    },
    onError: (
      _error: unknown,
      variables: { id: DeploymentExperimentId; enabled: boolean },
      context?: MutationContext,
    ) => {
      queryClient.setQueryData<Partial<DeploymentExperimentValues>>(
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
    onSettled: (
      _data: unknown,
      _error: unknown,
      variables: { id: DeploymentExperimentId },
    ) => {
      void queryClient.invalidateQueries({ queryKey });
      if (isNightly && isDeploymentExperimentRuntimeReadable(variables.id)) {
        void queryClient.invalidateQueries({
          queryKey: trpc.nightlyExperiments.runtime.queryKey({
            id: variables.id,
          }),
        });
      }
    },
  };

  const mutationOptions = isNightly
    ? trpc.nightlyExperiments.set.mutationOptions(mutationLifecycle)
    : trpc.deploymentExperiments.set.mutationOptions(mutationLifecycle);
  const mutation = useMutation(mutationOptions);

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

export function useDeploymentExperimentRuntime(
  id: DeploymentExperimentRuntimeId,
) {
  const { nightlyExperimentsEnabled } = useAuthorizedUser();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.nightlyExperiments.runtime.queryOptions(
      { id },
      { enabled: nightlyExperimentsEnabled === true },
    ),
  );

  return {
    enabled: nightlyExperimentsEnabled === true && query.data === true,
    isLoading: nightlyExperimentsEnabled === true && query.isPending,
  };
}

export function useDeploymentExperiment(
  id: DeploymentExperimentId,
  errorMessage: string,
) {
  const audience: DeploymentExperimentAudience | undefined =
    getDeploymentExperimentAudience(id);
  const state = useDeploymentExperiments(
    errorMessage,
    audience === 'internal-nightly' ? 'internal-nightly' : 'customer-preview',
  );
  return {
    enabled: state.experiments?.[id] === true,
    isLoading: state.isLoading,
    isUpdating: state.isUpdating,
    setEnabled: (enabled: boolean) => state.setExperiment(id, enabled),
  };
}
