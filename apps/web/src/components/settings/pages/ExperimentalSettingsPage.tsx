'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { HomeComposerSuggestionsExperimentalSetting } from '@/components/settings/HomeComposerSuggestionsExperimentalSetting';
import {
  Button,
  CircleX,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@/components/system';
import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';

export function ExperimentalSettingsPage() {
  const { error, hasLoadedPreferences, isFetching, refetch } =
    usePersonalPreferences();

  return (
    <SettingsShell pageId="experimental">
      {error && !hasLoadedPreferences ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="text-destructive">
              <CircleX />
            </EmptyMedia>
            <EmptyDescription className="text-sm">
              Failed to load experimental preferences.
            </EmptyDescription>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <HomeComposerSuggestionsExperimentalSetting />
          <ResultsExperimentalSetting />
        </>
      )}
    </SettingsShell>
  );
}
