'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useSessionTaskCommunicationTriageExperiment() {
  return useDeploymentExperiment(
    'sessionTaskCommunicationTriage',
    'Failed to update task communication triage.',
  );
}
