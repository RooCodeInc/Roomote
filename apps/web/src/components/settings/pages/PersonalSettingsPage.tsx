'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import {
  type UserProfileSectionProfile,
  UserProfileSection,
} from '@/components/settings/UserProfileSection';
import { ChangePasswordSection } from '@/components/settings/ChangePasswordSection';
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
      {canChangePassword ? <ChangePasswordSection /> : null}
      <UserPreferencesSection />
      <LinkedAccounts />
      <ShowDebugUISection />
    </SettingsShell>
  );
}
