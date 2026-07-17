'use client';

import { AgentGuidanceSection } from '@/components/settings/AgentGuidanceSection';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function AgentGuidanceSettingsPage() {
  return (
    <SettingsShell pageId="agent-guidance" adminOnly={true}>
      <AgentGuidanceSection />
    </SettingsShell>
  );
}
