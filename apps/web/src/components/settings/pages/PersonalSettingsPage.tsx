'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import {
  type UserProfileSectionProfile,
  UserProfileSection,
} from '@/components/settings/UserProfileSection';
import { LinkedAccounts } from '@/components/settings/LinkedAccounts';
import {
  ShowDebugUISection,
  UserPreferencesSection,
} from '@/components/settings';

export function PersonalSettingsPage({
  profile,
  canChangePassword,
}: {
  profile: UserProfileSectionProfile;
  canChangePassword: boolean;
}) {
  return (
    <SettingsShell pageId="personal">
      <UserProfileSection
        canChangePassword={canChangePassword}
        profile={profile}
      />
      <UserPreferencesSection />
      <LinkedAccounts />
      <ShowDebugUISection />
    </SettingsShell>
  );
}
