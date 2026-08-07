'use client';

import { CustomMcpServers } from '@/components/settings/CustomMcpServers';
import { Integrations } from '@/components/settings/Integrations';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function IntegrationsSettingsPage() {
  return (
    <SettingsShell pageId="integrations" adminOnly={true}>
      <Integrations />
      {/* Rendered outside Integrations so custom servers stay available when
          the curated catalog is disabled by the deployment operator. */}
      <CustomMcpServers />
    </SettingsShell>
  );
}
