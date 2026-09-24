'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

/**
 * Auto tool approvals are experimental; per-tool approvals are not. While
 * this is off, a tool nobody has made a choice about simply runs.
 */
export function useIntegrationToolAutoApprovalsExperiment() {
  return useDeploymentExperiment(
    'integrationToolAutoApprovals',
    'Failed to update Auto tool approvals.',
  );
}
