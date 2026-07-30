'use client';

import { Integrations } from '@/components/settings/Integrations';
import { MondayAgentSetup } from '@/components/settings/MondayAgentSetup';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function IntegrationsSettingsPage() {
  return (
    <SettingsShell pageId="integrations" adminOnly={true}>
      <div className="space-y-6">
        <MondayAgentSetup />
        <Integrations />
      </div>
    </SettingsShell>
  );
}
