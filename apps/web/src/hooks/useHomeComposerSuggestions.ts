'use client';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useHomeComposerSuggestions() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update Home suggestions.',
    });

  return {
    enabled: preferences.homeComposerSuggestionsEnabled === true,
    isLoading,
    isUpdating,
    setEnabled: (enabled: boolean) =>
      setPreferences({ homeComposerSuggestionsEnabled: enabled }),
  };
}
