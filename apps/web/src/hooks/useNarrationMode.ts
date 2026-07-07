'use client';

import { useCallback } from 'react';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useNarrationMode() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update narration mode.',
    });

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setPreferences({ narrationMode: enabled });
    },
    [setPreferences],
  );

  return {
    enabled: preferences.narrationMode,
    isLoading,
    isUpdating,
    setEnabled,
  };
}
