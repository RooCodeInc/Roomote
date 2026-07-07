'use client';

import { useCallback } from 'react';
import { useTheme } from 'next-themes';

import { usePersonalPreferences } from './usePersonalPreferences';

import type { PersonalColorTheme } from '@/types/preferences';

export function useColorTheme() {
  const { setTheme } = useTheme();
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update color theme.',
    });

  const setColorTheme = useCallback(
    (colorTheme: PersonalColorTheme) => {
      setTheme(colorTheme);
      setPreferences({ colorTheme });
    },
    [setPreferences, setTheme],
  );

  return {
    colorTheme: preferences.colorTheme,
    isLoading,
    isUpdating,
    setColorTheme,
  };
}
