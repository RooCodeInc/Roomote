'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { SlackPeerConversationsExperimentalSetting } from '@/components/settings/SlackPeerConversationsExperimentalSetting';
import { HomeComposerSuggestionsExperimentalSetting } from '@/components/settings/HomeComposerSuggestionsExperimentalSetting';
import { ServiceCredentialToolsExperimentalSetting } from '@/components/settings/ServiceCredentialToolsExperimentalSetting';
import { PrivateSessionsExperimentalSetting } from '@/components/settings/PrivateSessionsExperimentalSetting';
import { RetryableLoadError } from '@/components/system';
import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';
import { useAuthorizedUser } from '@/hooks/useUser';

export function ExperimentalSettingsPage() {
  const { isAdmin } = useAuthorizedUser();
  const { error, hasLoadedPreferences, isFetching, refetch } =
    usePersonalPreferences();

  return (
    <SettingsShell pageId="experimental">
      {isAdmin ? <PrivateSessionsExperimentalSetting /> : null}
      {error && !hasLoadedPreferences ? (
        <RetryableLoadError
          className="border"
          message="Failed to load experimental preferences."
          isRetrying={isFetching}
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <HomeComposerSuggestionsExperimentalSetting />
          <ResultsExperimentalSetting />
          <SlackPeerConversationsExperimentalSetting />
          <ServiceCredentialToolsExperimentalSetting />
        </>
      )}
    </SettingsShell>
  );
}
