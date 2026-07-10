'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { DeploymentSettings } from '@/components/settings/DeploymentSettings';

export function DeploymentSettingsPage() {
  return (
    <SettingsShell pageId="deployment" adminOnly={true}>
      <DeploymentSettings />
    </SettingsShell>
  );
}
