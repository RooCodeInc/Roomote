'use client';

import { Integrations } from '@/components/settings/Integrations';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function IntegrationsSettingsPage() {
  return (
    <SettingsShell pageId="integrations" adminOnly={true}>
      <Integrations />
    </SettingsShell>
  );
}
