import {
  type UseMutationOptions,
  type UseMutationResult,
  useMutation,
} from '@tanstack/react-query';

import type { RoutingDecision } from '@roomote/cloud-agents/server';

import { useTRPCClient } from '@/trpc/client';

type Variables = {
  description: string;
  images?: string[];
};

type Options = Omit<
  UseMutationOptions<RoutingDecision, Error, Variables>,
  'mutationFn'
>;

export function useRouteHomeTask(
  options: Options = {},
): UseMutationResult<RoutingDecision, Error, Variables> {
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (variables) =>
      trpcClient.cloudJobs.routeHomeTask.mutate(variables),
    ...options,
  });
}
