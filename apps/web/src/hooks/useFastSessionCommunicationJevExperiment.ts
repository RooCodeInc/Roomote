'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useFastSessionCommunicationJevExperiment() {
  return useDeploymentExperiment(
    'fastSessionCommunicationJev',
    'Failed to update Jev Session communication.',
  );
}
