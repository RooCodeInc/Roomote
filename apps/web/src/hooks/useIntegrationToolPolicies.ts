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
 * Per-tool approval policies (`integrationToolApprovals`
 * experiment). The list endpoint is admin-only server side, so callers gate
 * this query behind admin-only, open surfaces — for example the integration
 * tool management dialog only enables it while open for an admin with the
 * experiment on. Changes save immediately and take effect from the next
 * session turn.
 *
 * `scope: 'personal'` reads and writes the caller's own policies instead,
 * which any user can manage and which only tighten the deployment ones.
 */
export function useIntegrationToolPolicies(
  options: { enabled?: boolean; scope?: 'deployment' | 'personal' } = {},
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const personal = options.scope === 'personal';
  const list = personal
    ? trpc.integrationToolPolicies.listPersonal
    : trpc.integrationToolPolicies.list;
  const set = personal
    ? trpc.integrationToolPolicies.setPersonal
    : trpc.integrationToolPolicies.set;
  const listQuery = useQuery(
    list.queryOptions(undefined, { enabled: options.enabled ?? true }),
  );

  const modes = new Map(
    (listQuery.data ?? []).map((policy: IntegrationToolPolicyMetadata) => [
      integrationToolPolicyKey(policy.integrationId, policy.toolName),
      policy.mode,
    ]),
  );

  const setPolicy = useMutation(
    set.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(list.queryKey(), result);
      },
      onError: () => {
        toast.error('Failed to update the tool approval policy.');
      },
    }),
  );

  // A group-level change is one approval mode for many tools. The endpoint
  // is per tool, so the writes run in order and the list is refetched once at
  // the end; a failure stops the run and the refetch shows what was saved.
  const setModes = useMutation({
    mutationFn: async (input: {
      integrationId: string;
      toolNames: string[];
      mode: IntegrationToolPolicyMode;
    }) => {
      for (const toolName of input.toolNames) {
        await setPolicy.mutateAsync({
          integrationId: input.integrationId,
          toolName,
          mode: input.mode,
        });
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: list.queryKey() }),
  });

  return {
    isLoading: listQuery.isLoading,
    modes,
    isUpdating: setPolicy.isPending || setModes.isPending,
    setMode: (
      integrationId: string,
      toolName: string,
      mode: IntegrationToolPolicyMode,
    ) => setPolicy.mutate({ integrationId, toolName, mode }),
    setModes: (
      integrationId: string,
      toolNames: string[],
      mode: IntegrationToolPolicyMode,
    ) => setModes.mutate({ integrationId, toolNames, mode }),
  };
}
