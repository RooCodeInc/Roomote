'use client';

import { useCallback } from 'react';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useShowCommandOutput() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update command output visibility.',
    });

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setPreferences({ showCommandOutput: enabled });
    },
    [setPreferences],
  );

  return {
    enabled: preferences.showCommandOutput,
    isLoading,
    isUpdating,
    setEnabled,
  };
}
