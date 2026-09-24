'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useAutomationLaunchCriteriaExperiment() {
  return useDeploymentExperiment(
    'automationLaunchCriteria',
    'Failed to update custom automation launch criteria.',
  );
}
