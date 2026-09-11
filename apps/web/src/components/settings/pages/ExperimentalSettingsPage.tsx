'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ExperimentalSettings } from '@/components/settings/ExperimentalSettings';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { useAuthorizedUser } from '@/hooks/useUser';

export function ExperimentalSettingsPage() {
  const { isAdmin } = useAuthorizedUser();
  return (
    <SettingsShell pageId="experimental">
      <ResultsExperimentalSetting />
      {isAdmin ? <ExperimentalSettings /> : null}
    </SettingsShell>
  );
}
