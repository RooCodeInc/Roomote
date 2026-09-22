'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  IntegrationToolPolicyMetadata,
  IntegrationToolPolicyMode,
} from '@roomote/types';
import { integrationToolPolicyKey } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

type PolicyChange = {
  integrationId: string;
  toolNames: string[];
  mode: IntegrationToolPolicyMode;
};

function policyMatches(
  policy: IntegrationToolPolicyMetadata,
  integrationId: string,
  toolName: string,
) {
  return policy.integrationId === integrationId && policy.toolName === toolName;
}

function applyOptimisticPolicyChange(
  current: IntegrationToolPolicyMetadata[] | undefined,
  change: PolicyChange,
) {
  const now = new Date().toISOString();
  const next = [...(current ?? [])];

  for (const toolName of change.toolNames) {
    const index = next.findIndex((policy) =>
      policyMatches(policy, change.integrationId, toolName),
    );
    if (index >= 0) {
      next[index] = { ...next[index], mode: change.mode, updatedAt: now };
      continue;
    }

    next.push({
      policyId: `optimistic:${integrationToolPolicyKey(change.integrationId, toolName)}`,
      integrationId: change.integrationId,
      toolName,
      mode: change.mode,
      createdAt: now,
      updatedAt: now,
    });
  }

  return next;
}

function rollbackOptimisticPolicyChange(
  current: IntegrationToolPolicyMetadata[] | undefined,
  previous: IntegrationToolPolicyMetadata[] | undefined,
  change: PolicyChange,
) {
  const toolNames = new Set(change.toolNames);
  const previousByToolName = new Map(
    (previous ?? [])
      .filter(
        (policy) =>
          policy.integrationId === change.integrationId &&
          toolNames.has(policy.toolName),
      )
      .map((policy) => [policy.toolName, policy]),
  );
  const restoredToolNames = new Set<string>();
  const next = (current ?? []).flatMap((policy) => {
    if (
      policy.integrationId !== change.integrationId ||
      !toolNames.has(policy.toolName) ||
      policy.mode !== change.mode
    ) {
      return [policy];
    }

    restoredToolNames.add(policy.toolName);
    const prior = previousByToolName.get(policy.toolName);
    return prior ? [prior] : [];
  });

  for (const [toolName, policy] of previousByToolName) {
    if (!restoredToolNames.has(toolName)) next.push(policy);
  }

  return next;
}

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
  const queryKey = list.queryKey();

  const setPolicy = useMutation(
    set.mutationOptions({
      onMutate: (input) => {
        void queryClient.cancelQueries({ queryKey });
        const previous =
          queryClient.getQueryData<IntegrationToolPolicyMetadata[]>(queryKey);
        const change = {
          integrationId: input.integrationId,
          toolNames: [input.toolName],
          mode: input.mode,
        };
        queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
          queryKey,
          (current) => applyOptimisticPolicyChange(current, change),
        );
        return { previous, change };
      },
      onSuccess: (result, input) => {
        const saved = result.find((policy) =>
          policyMatches(policy, input.integrationId, input.toolName),
        );
        if (!saved) return;

        queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
          queryKey,
          (current) =>
            (current ?? []).map((policy) =>
              policyMatches(policy, input.integrationId, input.toolName) &&
              policy.mode === input.mode
                ? saved
                : policy,
            ),
        );
      },
      onError: (_error, _input, context) => {
        queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
          queryKey,
          (current) =>
            rollbackOptimisticPolicyChange(
              current,
              context?.previous,
              context?.change ?? {
                integrationId: _input.integrationId,
                toolNames: [_input.toolName],
                mode: _input.mode,
              },
            ),
        );
        toast.error('Failed to update the tool approval policy.');
      },
    }),
  );

  // A group-level change is one approval mode for many tools. The endpoint
  // is per tool, so the writes run in order and the list is refetched once at
  // the end; a failure stops the run and the refetch shows what was saved.
  const setModes = useMutation({
    mutationFn: async (input: PolicyChange) => {
      for (const toolName of input.toolNames) {
        await setPolicy.mutateAsync({
          integrationId: input.integrationId,
          toolName,
          mode: input.mode,
        });
      }
    },
    onMutate: (change) => {
      void queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<IntegrationToolPolicyMetadata[]>(queryKey);
      queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
        queryKey,
        (current) => applyOptimisticPolicyChange(current, change),
      );
      return { previous, change };
    },
    onSuccess: () => {
      toast.success('Tool approval policies updated.');
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
        queryKey,
        (current) =>
          rollbackOptimisticPolicyChange(
            current,
            context?.previous,
            context?.change ?? _input,
          ),
      );
    },
  });

  return {
    isLoading: listQuery.isLoading,
    modes,
    isUpdating: setPolicy.isPending || setModes.isPending,
    setMode: (
      integrationId: string,
      toolName: string,
      mode: IntegrationToolPolicyMode,
    ) =>
      setPolicy.mutate(
        { integrationId, toolName, mode },
        {
          onSuccess: () => {
            toast.success('Tool approval policy updated.');
          },
        },
      ),
    setModes: (
      integrationId: string,
      toolNames: string[],
      mode: IntegrationToolPolicyMode,
    ) => setModes.mutate({ integrationId, toolNames, mode }),
  };
}
