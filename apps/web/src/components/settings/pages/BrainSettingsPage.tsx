'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { BrainSettings } from '@/components/settings/brain/BrainSettings';

export function BrainSettingsPage() {
  return (
    <SettingsShell pageId="memory" adminOnly={true}>
      <BrainSettings />
    </SettingsShell>
  );
}
