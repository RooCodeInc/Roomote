'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useResultsPage() {
  return useDeploymentExperiment('results', 'Failed to update Results.');
}
