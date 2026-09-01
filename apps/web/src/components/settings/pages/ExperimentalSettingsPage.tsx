'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ExperimentalSettings } from '@/components/settings/ExperimentalSettings';

export function ExperimentalSettingsPage() {
  return (
    <SettingsShell pageId="experimental" adminOnly={true}>
      <ExperimentalSettings />
    </SettingsShell>
  );
}
