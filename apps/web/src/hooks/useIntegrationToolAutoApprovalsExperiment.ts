'use client';

import { useQuery } from '@tanstack/react-query';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

/**
 * Auto tool approvals are an internal nightly experiment; per-tool approvals
 * are not. The runtime value is readable by members only on opted-in internal
 * deployments, so ordinary deployments never query the admin-only settings
 * procedure.
 */
export function useIntegrationToolAutoApprovalsExperiment() {
  const { nightlyExperimentsEnabled } = useAuthorizedUser();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.nightlyExperiments.integrationToolAutoApprovalsEnabled.queryOptions(
      undefined,
      { enabled: nightlyExperimentsEnabled === true },
    ),
  );

  return {
    enabled: nightlyExperimentsEnabled === true && query.data === true,
    isLoading: nightlyExperimentsEnabled === true && query.isPending,
  };
}
