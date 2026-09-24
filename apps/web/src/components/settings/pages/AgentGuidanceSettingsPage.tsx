'use client';

import { AgentGuidanceSection } from '@/components/settings/AgentGuidanceSection';
import { IntegrationToolAutoModeSection } from '@/components/settings/IntegrationToolAutoModeSection';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function AgentGuidanceSettingsPage() {
  return (
    <SettingsShell pageId="agent-guidance" adminOnly={true}>
      <IntegrationToolAutoModeSection />
      <AgentGuidanceSection />
    </SettingsShell>
  );
}
