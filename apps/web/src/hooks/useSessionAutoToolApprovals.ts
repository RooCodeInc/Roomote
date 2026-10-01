'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import { useIntegrationToolAutoApprovalsExperiment } from './useIntegrationToolAutoApprovalsExperiment';

/**
 * Whether a composer that starts a new session should offer Auto, and
 * whether it can be turned on yet. Auto is the session owner's choice for
 * one session and starts off.
 */
export function useNewSessionAutoToolApprovals() {
  const { enabled: experimentEnabled } =
    useIntegrationToolAutoApprovalsExperiment();
  const trpc = useTRPC();
  const state = useQuery(
    trpc.fastSessions.autoToolApprovals.queryOptions(
      {},
      { enabled: experimentEnabled },
    ),
  );
  return {
    shown: experimentEnabled && state.data !== undefined,
    available: state.data?.available === true,
  };
}

/**
 * Auto for one running session, as its owner sees and changes it. `state` is
 * undefined while the experiment is off or the state has not loaded.
 */
export function useSessionAutoToolApprovals(
  /** The unified session, which approvals are keyed on. */
  sessionId: string,
) {
  const { enabled: experimentEnabled } =
    useIntegrationToolAutoApprovalsExperiment();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const state = useQuery(
    trpc.fastSessions.autoToolApprovals.queryOptions(
      { sessionId },
      {
        enabled: experimentEnabled,
        // Auto can pause itself mid-turn; keep the switch honest while on.
        refetchInterval: (query) =>
          query.state.data?.enabled ? 10_000 : false,
      },
    ),
  );
  const save = useMutation(
    trpc.fastSessions.setAutoToolApprovals.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(
          trpc.fastSessions.autoToolApprovals.queryKey({ sessionId }),
          result,
        );
      },
      onError: () => toast.error('Failed to update auto-approval.'),
    }),
  );
  return {
    state: experimentEnabled ? state.data : undefined,
    isSaving: save.isPending,
    setEnabled: (enabled: boolean) => save.mutate({ sessionId, enabled }),
  };
}
