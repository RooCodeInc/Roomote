'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { UsersSettings } from '@/components/settings/UsersSettings';

export function UsersSettingsPage() {
  return (
    <SettingsShell pageId="users" adminOnly={true}>
      <UsersSettings />
    </SettingsShell>
  );
}
