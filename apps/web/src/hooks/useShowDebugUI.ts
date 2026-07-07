'use client';

import { useCallback } from 'react';

import { FeatureFlag } from '@roomote/feature-flags';

import { usePersonalPreferences } from './usePersonalPreferences';
import { useUser } from './useUser';

export function useShowDebugUI() {
  const { isSignedIn, user } = useUser();
  const canUseDebugUI =
    isSignedIn && user.featureFlags[FeatureFlag.ShowDebugUISetting] === true;
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      enabled: canUseDebugUI,
      errorMessage: 'Failed to update debug UI preference.',
    });

  const setDebugUIVisible = useCallback(
    (showDebugUI: boolean) => {
      if (!canUseDebugUI) {
        return;
      }

      setPreferences({ showDebugUI });
    },
    [canUseDebugUI, setPreferences],
  );

  return {
    canUseDebugUI,
    isDebugUIVisible: canUseDebugUI && preferences.showDebugUI,
    isLoading,
    isUpdating,
    setDebugUIVisible,
  };
}
