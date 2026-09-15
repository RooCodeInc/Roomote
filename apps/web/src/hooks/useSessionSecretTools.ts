'use client';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useSessionSecretTools() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update Session secret tools.',
    });

  return {
    enabled: preferences.sessionSecretToolsEnabled === true,
    isLoading,
    isUpdating,
    setEnabled: (enabled: boolean) =>
      setPreferences({ sessionSecretToolsEnabled: enabled }),
  };
}
