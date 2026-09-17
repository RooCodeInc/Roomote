'use client';

import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';

import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';
import { useUser } from '@/hooks/useUser';
import { PERSONAL_THEME_STORAGE_KEY } from '@/types/preferences';

export function PersonalThemeSync() {
  const { isSignedIn } = useUser();
  const { preferences, hasLoadedPreferences, isLoading, refetch } =
    usePersonalPreferences({
      enabled: isSignedIn,
    });
  const { theme, setTheme } = useTheme();
  const [authoritativePreferencesVersion, setAuthoritativePreferencesVersion] =
    useState(0);
  const hasAuthoritativePreferencesRef = useRef(false);
  const wasSignedInRef = useRef(isSignedIn);

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }

    let cancelled = false;

    void refetch().then((result) => {
      if (!cancelled && result.isSuccess) {
        hasAuthoritativePreferencesRef.current = true;
        setAuthoritativePreferencesVersion((version) => version + 1);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isSignedIn, refetch]);

  useEffect(() => {
    if (wasSignedInRef.current && !isSignedIn) {
      window.localStorage.removeItem(PERSONAL_THEME_STORAGE_KEY);

      if (theme !== 'system') {
        setTheme('system');
      }
    }

    wasSignedInRef.current = isSignedIn;

    if (!isSignedIn) {
      hasAuthoritativePreferencesRef.current = false;
      return;
    }

    if (
      isLoading ||
      !hasLoadedPreferences ||
      !hasAuthoritativePreferencesRef.current
    ) {
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
  }, [
    authoritativePreferencesVersion,
    hasLoadedPreferences,
    isLoading,
    isSignedIn,
    preferences.colorTheme,
    setTheme,
    theme,
  ]);

  return null;
}
