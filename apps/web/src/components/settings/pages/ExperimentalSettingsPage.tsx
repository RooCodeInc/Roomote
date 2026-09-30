'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ExperimentSettingsControls } from '@/components/settings/experiment-settings-controls';
import { RetryableLoadError } from '@/components/system';
import { useDeploymentExperiments } from '@/hooks/useDeploymentExperiments';

export function ExperimentalSettingsPage() {
  const { error, hasLoadedExperiments, isFetching, refetch } =
    useDeploymentExperiments(undefined, 'customer-preview');

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
          <ExperimentSettingsControls audience="customer-preview" />
        </>
      )}
    </SettingsShell>
  );
}
