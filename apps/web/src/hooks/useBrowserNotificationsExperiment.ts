'use client';

import { useDeploymentExperiment } from './useDeploymentExperiments';

export function useBrowserNotificationsExperiment() {
  return useDeploymentExperiment(
    'browserNotifications',
    'Failed to update browser notifications.',
  );
}
