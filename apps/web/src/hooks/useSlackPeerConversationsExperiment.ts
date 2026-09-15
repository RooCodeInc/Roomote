'use client';

import { usePersonalPreferences } from './usePersonalPreferences';

export function useSlackPeerConversationsExperiment() {
  const { preferences, isLoading, isUpdating, setPreferences } =
    usePersonalPreferences({
      errorMessage: 'Failed to update peer conversations.',
    });

  return {
    enabled: preferences.slackPeerConversationsExperimentEnabled === true,
    isLoading,
    isUpdating,
    setEnabled: (enabled: boolean) =>
      setPreferences({ slackPeerConversationsExperimentEnabled: enabled }),
  };
}
