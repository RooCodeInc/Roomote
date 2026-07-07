'use client';

import { FeatureFlag } from '@roomote/feature-flags';

import { AgentGuidanceSection } from '@/components/settings/AgentGuidanceSection';
import { AuthorshipRulesSection } from '@/components/settings/AuthorshipRulesSection';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { useAuthorizedUser } from '@/hooks/useUser';

export function AgentGuidanceSettingsPage() {
  const { featureFlags } = useAuthorizedUser();
  const authorshipRulesEnabled =
    featureFlags[FeatureFlag.AuthorshipRules] === true;

  return (
    <SettingsShell pageId="agent-guidance" adminOnly={true}>
      {authorshipRulesEnabled ? <AuthorshipRulesSection /> : null}
      <AgentGuidanceSection />
    </SettingsShell>
  );
}
