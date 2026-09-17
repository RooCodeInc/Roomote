'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function usePrivateSessionsExperiment() {
  return useDeploymentExperiment(
    'privateSessions',
    'Failed to update Private Sessions.',
  );
}
