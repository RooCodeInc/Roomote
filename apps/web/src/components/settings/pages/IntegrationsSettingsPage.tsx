'use client';

import { Integrations } from '@/components/settings/Integrations';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { YourIntegrations } from '@/components/settings/YourIntegrations';

export function IntegrationsSettingsPage() {
  return (
    <SettingsShell pageId="integrations">
      <YourIntegrations />
      <Integrations />
    </SettingsShell>
  );
}
