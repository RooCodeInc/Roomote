'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';

export function ExperimentalSettingsPage() {
  return (
    <SettingsShell pageId="experimental" adminOnly={true}>
      {null}
    </SettingsShell>
  );
}
