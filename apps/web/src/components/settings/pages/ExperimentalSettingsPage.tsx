'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { ResultsExperimentalSetting } from '@/components/settings/ResultsExperimentalSetting';
import { SlackPeerConversationsExperimentalSetting } from '@/components/settings/SlackPeerConversationsExperimentalSetting';

export function ExperimentalSettingsPage() {
  return (
    <SettingsShell pageId="experimental">
      <ResultsExperimentalSetting />
      <SlackPeerConversationsExperimentalSetting />
    </SettingsShell>
  );
}
