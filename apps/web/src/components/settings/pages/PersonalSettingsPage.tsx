'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import {
  type UserProfileSectionProfile,
  UserProfileSection,
} from '@/components/settings/UserProfileSection';
import { ChangePasswordSection } from '@/components/settings/ChangePasswordSection';
import { LinkedAccounts } from '@/components/settings/LinkedAccounts';
import { PersonalIntegrations } from '@/components/settings/PersonalIntegrations';
import { BrowserNotificationsSection } from '@/components/settings/BrowserNotificationsSection';
import {
  PersonalizationSection,
  UserPreferencesSection,
} from '@/components/settings';

export function PersonalSettingsPage({
  profile,
  canChangePassword,
  canSetPassword,
}: {
  profile: UserProfileSectionProfile;
  canChangePassword: boolean;
  canSetPassword: boolean;
}) {
  return (
    <SettingsShell pageId="personal">
      <UserProfileSection
        canChangePassword={canChangePassword}
        profile={profile}
      />
      {canChangePassword || canSetPassword ? (
        <ChangePasswordSection mode={canChangePassword ? 'change' : 'set'} />
      ) : null}
      <UserPreferencesSection />
      <BrowserNotificationsSection />
      <PersonalizationSection />
      <LinkedAccounts />
      <PersonalIntegrations />
    </SettingsShell>
  );
}
