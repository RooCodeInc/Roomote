'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { VibesSettings } from '@/components/settings/VibesSettings';

export function VibesSettingsPage() {
  return (
    <SettingsShell pageId="vibes" adminOnly={true}>
      <VibesSettings />
    </SettingsShell>
  );
}
