'use client';

import { usePersonalPreferences } from './usePersonalPreferences';

export function usePrivateSessionsExperiment() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update Private Sessions.',
    });

  return {
    enabled: preferences.privateSessionsExperimentEnabled === true,
    isLoading,
    isUpdating,
    setEnabled: (enabled: boolean) =>
      setPreferences({ privateSessionsExperimentEnabled: enabled }),
  };
}
