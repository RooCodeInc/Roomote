'use client';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useServiceCredentialTools() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update integration keys.',
    });

  return {
    enabled: preferences.serviceCredentialToolsEnabled === true,
    isLoading,
    isUpdating,
    setEnabled: (enabled: boolean) =>
      setPreferences({ serviceCredentialToolsEnabled: enabled }),
  };
}
