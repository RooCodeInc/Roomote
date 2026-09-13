'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';

export function ExperimentalSettingsPage() {
  return (
    <SettingsShell pageId="experimental">
      <ResultsExperimentalSetting />
    </SettingsShell>
  );
}
