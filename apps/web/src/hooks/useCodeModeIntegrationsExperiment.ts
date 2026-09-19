'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useCodeModeIntegrationsExperiment() {
  return useDeploymentExperiment(
    'codeModeIntegrations',
    'Failed to update code mode integrations.',
  );
}
