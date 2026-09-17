'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { SlackPeerConversationsExperimentalSetting } from '@/components/settings/SlackPeerConversationsExperimentalSetting';
import { HomeComposerSuggestionsExperimentalSetting } from '@/components/settings/HomeComposerSuggestionsExperimentalSetting';
import { ServiceCredentialToolsExperimentalSetting } from '@/components/settings/ServiceCredentialToolsExperimentalSetting';
import { PrivateSessionsExperimentalSetting } from '@/components/settings/PrivateSessionsExperimentalSetting';
import { RetryableLoadError } from '@/components/system';
import { useDeploymentExperiments } from '@/hooks/useDeploymentExperiments';

export function ExperimentalSettingsPage() {
  const { error, hasLoadedExperiments, isFetching, refetch } =
    useDeploymentExperiments();

  return (
    <SettingsShell pageId="experimental" adminOnly={true}>
      {error && !hasLoadedExperiments ? (
        <RetryableLoadError
          className="border"
          message="Failed to load experimental settings."
          isRetrying={isFetching}
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <PrivateSessionsExperimentalSetting />
          <HomeComposerSuggestionsExperimentalSetting />
          <ResultsExperimentalSetting />
          <SlackPeerConversationsExperimentalSetting />
          <ServiceCredentialToolsExperimentalSetting />
        </>
      )}
    </SettingsShell>
  );
}
