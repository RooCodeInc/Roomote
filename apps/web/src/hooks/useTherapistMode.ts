'use client';

import { useCallback } from 'react';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useTherapistMode() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update therapist mode.',
    });

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setPreferences({ therapistMode: enabled });
    },
    [setPreferences],
  );

  return {
    enabled: preferences.therapistMode,
    isLoading,
    isUpdating,
    setEnabled,
  };
}
