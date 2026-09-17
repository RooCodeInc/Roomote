'use client';

import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/trpc/client';

import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';
import { useUser } from '@/hooks/useUser';
import { PERSONAL_THEME_STORAGE_KEY } from '@/types/preferences';

export function PersonalThemeSync() {
  const { isSignedIn } = useUser();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const preferencesQueryHash = hashKey(trpc.preferences.getPersonal.queryKey());
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

    // Optimistic setQueryData writes also report success. Only a completed
    // fetch can make fallback preferences authoritative, including recovery
    // after the initial request has failed.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        hashKey(event.query.queryKey) === preferencesQueryHash &&
        event.action.type === 'success' &&
        !event.action.manual
      ) {
        hasAuthoritativePreferencesRef.current = true;
        setAuthoritativePreferencesVersion((version) => version + 1);
      }
    });
    void refetch();
    return unsubscribe;
  }, [isSignedIn, preferencesQueryHash, queryClient, refetch]);

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
