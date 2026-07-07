'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';
import { useUser } from '@/hooks/useUser';
import { PERSONAL_THEME_STORAGE_KEY } from '@/types/preferences';

export function PersonalThemeSync() {
  const { isSignedIn } = useUser();
  const { preferences, isLoading } = usePersonalPreferences({
    enabled: isSignedIn,
  });
  const { theme, setTheme } = useTheme();
  const wasSignedInRef = useRef(isSignedIn);

  useEffect(() => {
    if (wasSignedInRef.current && !isSignedIn) {
      window.localStorage.removeItem(PERSONAL_THEME_STORAGE_KEY);

      if (theme !== 'system') {
        setTheme('system');
      }
    }

    wasSignedInRef.current = isSignedIn;

    if (!isSignedIn || isLoading) {
      return;
    }

    if (theme !== preferences.colorTheme) {
      setTheme(preferences.colorTheme);
      return;
    }

    if (
      window.localStorage.getItem(PERSONAL_THEME_STORAGE_KEY) !==
      preferences.colorTheme
    ) {
      window.localStorage.setItem(
        PERSONAL_THEME_STORAGE_KEY,
        preferences.colorTheme,
      );
    }
  }, [isLoading, isSignedIn, preferences.colorTheme, setTheme, theme]);

  return null;
}
