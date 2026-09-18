'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useHomeComposerSuggestions() {
  return useDeploymentExperiment(
    'homeComposerSuggestions',
    'Failed to update home suggestions.',
  );
}
