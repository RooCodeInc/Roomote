'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { SourceControl } from '@/components/settings/SourceControl';

export function SourceControlSettingsPage() {
  return (
    <SettingsShell pageId="source-control" adminOnly={true}>
      <SourceControl />
    </SettingsShell>
  );
}
