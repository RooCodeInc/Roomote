'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useHomeComposerSuggestions() {
  return useDeploymentExperiment(
    'homeComposerSuggestions',
    'Failed to update Home suggestions.',
  );
}
