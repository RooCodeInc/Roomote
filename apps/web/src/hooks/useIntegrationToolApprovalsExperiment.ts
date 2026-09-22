'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useIntegrationToolApprovalsExperiment() {
  return useDeploymentExperiment(
    'integrationToolApprovals',
    'Failed to update integration tool approvals.',
  );
}
