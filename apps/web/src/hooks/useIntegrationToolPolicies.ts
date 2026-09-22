'use client';

import { useRef } from 'react';

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

type QueuedPolicyChange = {
  change: PolicyChange;
  previous?: IntegrationToolPolicyMetadata[];
  revisions: Map<string, number>;
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
    const existing = next[index];
    if (existing) {
      next[index] = { ...existing, mode: change.mode, updatedAt: now };
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
  const currentToolNames = new Set<string>();
  const next = (current ?? []).flatMap((policy) => {
    if (
      policy.integrationId === change.integrationId &&
      toolNames.has(policy.toolName)
    ) {
      currentToolNames.add(policy.toolName);
    }
    if (
      policy.integrationId !== change.integrationId ||
      !toolNames.has(policy.toolName) ||
      policy.mode !== change.mode
    ) {
      return [policy];
    }

    const prior = previousByToolName.get(policy.toolName);
    return prior ? [prior] : [];
  });

  for (const [toolName, policy] of previousByToolName) {
    if (!currentToolNames.has(toolName)) next.push(policy);
  }

  return next;
}

function reconcileSavedPolicies(
  current: IntegrationToolPolicyMetadata[] | undefined,
  saved: IntegrationToolPolicyMetadata[],
  change: PolicyChange,
) {
  const toolNames = new Set(change.toolNames);
  const savedByToolName = new Map(
    saved
      .filter(
        (policy) =>
          policy.integrationId === change.integrationId &&
          toolNames.has(policy.toolName),
      )
      .map((policy) => [policy.toolName, policy]),
  );

  return (current ?? []).map((policy) => {
    if (
      policy.integrationId !== change.integrationId ||
      !toolNames.has(policy.toolName) ||
      policy.mode !== change.mode
    ) {
      return policy;
    }
    return savedByToolName.get(policy.toolName) ?? policy;
  });
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
    ? trpc.integrationToolPolicies.setManyPersonal
    : trpc.integrationToolPolicies.setMany;
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
  const revisionByPolicy = useRef(new Map<string, number>());
  const writePolicies = useMutation(set.mutationOptions());

  // Serialize whole user actions, while applying every selection to the cache
  // before it enters the queue. This keeps the controls instant and preserves
  // click order on the server even when someone changes modes rapidly.
  const savePolicies = useMutation({
    scope: {
      id: `integration-tool-policies:${personal ? 'personal' : 'deployment'}`,
    },
    mutationFn: ({ change }: QueuedPolicyChange) =>
      writePolicies.mutateAsync(change),
    onSuccess: (result, { change }) => {
      queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
        queryKey,
        (current) => reconcileSavedPolicies(current, result, change),
      );
      toast.success(
        change.toolNames.length === 1
          ? 'Tool approval policy updated.'
          : 'Tool approval policies updated.',
      );
    },
    onError: async (_error, { change, previous, revisions }) => {
      const currentChange = {
        ...change,
        toolNames: change.toolNames.filter((toolName) => {
          const key = integrationToolPolicyKey(change.integrationId, toolName);
          return revisionByPolicy.current.get(key) === revisions.get(key);
        }),
      };
      queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
        queryKey,
        (current) =>
          rollbackOptimisticPolicyChange(current, previous, currentChange),
      );
      // A queued failure may have an older snapshot than the cache now in
      // memory. Refetch after every failure so the queue settles on server
      // truth instead of restoring a stale optimistic mode.
      await queryClient.invalidateQueries({ queryKey });
      toast.error(
        change.toolNames.length === 1
          ? 'Failed to update the tool approval policy.'
          : 'Failed to update the tool approval policies.',
      );
    },
  });

  const setModes = (change: PolicyChange) => {
    void queryClient.cancelQueries({ queryKey });
    const previous =
      queryClient.getQueryData<IntegrationToolPolicyMetadata[]>(queryKey);
    const revisions = new Map<string, number>();
    for (const toolName of change.toolNames) {
      const key = integrationToolPolicyKey(change.integrationId, toolName);
      const revision = (revisionByPolicy.current.get(key) ?? 0) + 1;
      revisionByPolicy.current.set(key, revision);
      revisions.set(key, revision);
    }
    queryClient.setQueryData<IntegrationToolPolicyMetadata[]>(
      queryKey,
      (current) => applyOptimisticPolicyChange(current, change),
    );
    savePolicies.mutate({ change, previous, revisions });
  };

  return {
    isLoading: listQuery.isLoading,
    modes,
    isUpdating: writePolicies.isPending || savePolicies.isPending,
    setMode: (
      integrationId: string,
      toolName: string,
      mode: IntegrationToolPolicyMode,
    ) => setModes({ integrationId, toolNames: [toolName], mode }),
    setModes: (
      integrationId: string,
      toolNames: string[],
      mode: IntegrationToolPolicyMode,
    ) => setModes({ integrationId, toolNames, mode }),
  };
}
