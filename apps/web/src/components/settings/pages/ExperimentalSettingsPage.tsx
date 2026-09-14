'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { HomeComposerSuggestionsExperimentalSetting } from '@/components/settings/HomeComposerSuggestionsExperimentalSetting';

export function ExperimentalSettingsPage() {
  return (
    <SettingsShell pageId="experimental">
      <HomeComposerSuggestionsExperimentalSetting />
      <ResultsExperimentalSetting />
    </SettingsShell>
  );
}
