'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import {
  ExperimentSettingsControls,
  getExperimentSettingIds,
} from '@/components/settings/experiment-settings-controls';
import { EmptyState, Moon, RetryableLoadError } from '@/components/system';
import { useDeploymentExperiments } from '@/hooks/useDeploymentExperiments';

export function NightlyExperimentsPage() {
  const { error, hasLoadedExperiments, isFetching, refetch } =
    useDeploymentExperiments(
      'Failed to load nightly experiments.',
      'internal-nightly',
    );
  const settingIds = getExperimentSettingIds('internal-nightly');

  return (
    <SettingsShell pageId="nightly-experiments" adminOnly={true}>
      {error && !hasLoadedExperiments ? (
        <RetryableLoadError
          className="border"
          message="Failed to load nightly experiments."
          isRetrying={isFetching}
          onRetry={() => void refetch()}
        />
      ) : settingIds.length === 0 ? (
        <EmptyState
          icon={<Moon className="size-6" />}
          title="No internal nightly experiments"
          description="There are no internal nightly controls available on this deployment."
        />
      ) : (
        <ExperimentSettingsControls audience="internal-nightly" />
      )}
    </SettingsShell>
  );
}
