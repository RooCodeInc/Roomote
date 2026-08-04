'use client';

import { useCallback } from 'react';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useMindReaderMode() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update mind reader mode.',
    });

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setPreferences({ mindReaderMode: enabled });
    },
    [setPreferences],
  );

  return {
    enabled: preferences.mindReaderMode,
    isLoading,
    isUpdating,
    setEnabled,
  };
}
