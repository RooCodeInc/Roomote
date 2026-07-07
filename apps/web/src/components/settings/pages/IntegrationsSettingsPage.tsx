'use client';

import { EnvVars } from '@/components/settings/EnvVars';
import { Integrations } from '@/components/settings/Integrations';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function IntegrationsSettingsPage() {
  return (
    <SettingsShell pageId="integrations" adminOnly={true}>
      <Integrations />
      <EnvVars />
    </SettingsShell>
  );
}
