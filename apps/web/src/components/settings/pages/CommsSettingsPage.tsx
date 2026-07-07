'use client';

import { CommsProviders } from '@/components/settings/CommsProviders';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function CommsSettingsPage() {
  return (
    <SettingsShell pageId="comms" adminOnly={true}>
      <CommsProviders />
    </SettingsShell>
  );
}
