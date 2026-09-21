'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  IntegrationToolPolicyMetadata,
  IntegrationToolPolicyMode,
} from '@roomote/types';
import { integrationToolPolicyKey } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

/**
 * Deployment-wide per-tool approval policies (`integrationToolApprovals`
 * experiment). The list endpoint is admin-only server side, so callers gate
 * this query behind admin-only, open surfaces — for example the integration
 * tool management dialog only enables it while open for an admin with the
 * experiment on. Changes save immediately and take effect from the next
 * session turn.
 */
export function useIntegrationToolPolicies(
  options: { enabled?: boolean } = {},
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listQuery = useQuery(
    trpc.integrationToolPolicies.list.queryOptions(undefined, {
      enabled: options.enabled ?? true,
    }),
  );

  const modes = new Map(
    (listQuery.data ?? []).map((policy: IntegrationToolPolicyMetadata) => [
      integrationToolPolicyKey(policy.integrationId, policy.toolName),
      policy.mode,
    ]),
  );

  const setPolicy = useMutation(
    trpc.integrationToolPolicies.set.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(
          trpc.integrationToolPolicies.list.queryKey(),
          result,
        );
      },
      onError: () => {
        toast.error('Failed to update the tool approval policy.');
      },
    }),
  );

  return {
    isLoading: listQuery.isLoading,
    modes,
    isUpdating: setPolicy.isPending,
    setMode: (
      integrationId: string,
      toolName: string,
      mode: IntegrationToolPolicyMode,
    ) => setPolicy.mutate({ integrationId, toolName, mode }),
  };
}
