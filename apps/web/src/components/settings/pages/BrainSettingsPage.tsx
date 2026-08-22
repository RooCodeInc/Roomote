'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { BrainSettings } from '@/components/settings/brain/BrainSettings';

export function BrainSettingsPage() {
  return (
    <SettingsShell pageId="brain" adminOnly={true}>
      <BrainSettings />
    </SettingsShell>
  );
}
