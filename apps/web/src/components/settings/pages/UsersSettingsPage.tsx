'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { UsersSettings } from '@/components/settings/UsersSettings';
import { UserMcpClients } from '@/components/settings/ConnectedMcpClients';

export function UsersSettingsPage() {
  return (
    <SettingsShell pageId="users" adminOnly={true}>
      <UsersSettings />
      <UserMcpClients />
    </SettingsShell>
  );
}
