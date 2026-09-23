'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { PrivateSessionsExperimentalSetting } from '@/components/settings/PrivateSessionsExperimentalSetting';
import { BrowserNotificationsExperimentalSetting } from '@/components/settings/BrowserNotificationsExperimentalSetting';
import { SessionTaskCommunicationTriageExperimentalSetting } from '@/components/settings/SessionTaskCommunicationTriageExperimentalSetting';
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
          <SessionTaskCommunicationTriageExperimentalSetting />
          <BrowserNotificationsExperimentalSetting />
          <ResultsExperimentalSetting />
        </>
      )}
    </SettingsShell>
  );
}
