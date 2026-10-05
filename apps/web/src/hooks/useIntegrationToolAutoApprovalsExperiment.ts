'use client';

import { useDeploymentExperimentRuntime } from './useDeploymentExperiments';

/**
 * Auto tool approvals are an internal nightly experiment; per-tool approvals
 * are not. The runtime value is readable by members only on opted-in internal
 * deployments, so ordinary deployments never query the nightly runtime
 * procedure.
 */
export function useIntegrationToolAutoApprovalsExperiment() {
  return useDeploymentExperimentRuntime('integrationToolAutoApprovals');
}
