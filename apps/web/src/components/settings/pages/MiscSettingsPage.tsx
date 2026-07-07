'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { MiscSettings } from '@/components/settings/MiscSettings';

export function MiscSettingsPage() {
  return (
    <SettingsShell pageId="misc" adminOnly={true}>
      <MiscSettings />
    </SettingsShell>
  );
}
