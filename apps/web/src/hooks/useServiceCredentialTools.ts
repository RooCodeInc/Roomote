'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useServiceCredentialTools() {
  return useDeploymentExperiment(
    'serviceCredentialTools',
    'Failed to update integration keys.',
  );
}
