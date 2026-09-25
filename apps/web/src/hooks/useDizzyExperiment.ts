'use client';

import { useDeploymentExperimentRuntime } from './useDeploymentExperiments';

export function useDizzyExperiment(): boolean {
  return useDeploymentExperimentRuntime('dizzy').enabled;
}
