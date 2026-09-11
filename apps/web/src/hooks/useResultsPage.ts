'use client';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useResultsPage() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({ errorMessage: 'Failed to update Results.' });

  return {
    enabled: preferences.resultsPageEnabled === true,
    isLoading,
    isUpdating,
    setEnabled: (enabled: boolean) =>
      setPreferences({ resultsPageEnabled: enabled }),
  };
}
