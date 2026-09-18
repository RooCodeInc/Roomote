'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useToolApprovalsExperiment() {
  return useDeploymentExperiment(
    'toolApprovals',
    'Failed to update tool approvals.',
  );
}
