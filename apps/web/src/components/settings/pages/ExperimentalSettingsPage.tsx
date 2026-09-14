'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { HomeComposerSuggestionsExperimentalSetting } from '@/components/settings/HomeComposerSuggestionsExperimentalSetting';
import { RetryableLoadError } from '@/components/system';
import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';

export function ExperimentalSettingsPage() {
  const { error, hasLoadedPreferences, isFetching, refetch } =
    usePersonalPreferences();

  return (
    <SettingsShell pageId="experimental">
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
        </>
      )}
    </SettingsShell>
  );
}
