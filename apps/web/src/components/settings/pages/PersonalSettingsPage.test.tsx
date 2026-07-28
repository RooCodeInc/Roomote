import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { changePasswordSectionMock, userProfileSectionMock } = vi.hoisted(
  () => ({
    changePasswordSectionMock: vi.fn(),
    userProfileSectionMock: vi.fn(),
  }),
);

vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/settings/UserProfileSection', () => ({
  UserProfileSection: userProfileSectionMock,
}));

vi.mock('@/components/settings/ChangePasswordSection', () => ({
  ChangePasswordSection: changePasswordSectionMock,
}));

vi.mock('@/components/settings/LinkedAccounts', () => ({
  LinkedAccounts: () => <section>Linked accounts</section>,
}));

vi.mock('@/components/settings', () => ({
  ShowDebugUISection: () => <section>Debug UI</section>,
  UserPreferencesSection: () => <section>User preferences</section>,
}));

import { PersonalSettingsPage } from './PersonalSettingsPage';

const profile = {
  email: 'ada@example.com',
  imageUrl: '',
  name: 'Ada Lovelace',
};

describe('PersonalSettingsPage', () => {
  beforeEach(() => {
    userProfileSectionMock.mockImplementation(() => (
      <section>User profile</section>
    ));
    changePasswordSectionMock.mockImplementation(() => (
      <section>Change password</section>
    ));
  });

  it('passes credential editing availability to the user profile section', () => {
    render(
      <PersonalSettingsPage
        canChangePassword={true}
        canSetPassword={false}
        profile={profile}
      />,
    );

    expect(screen.getByText('User profile')).toBeInTheDocument();
    expect(userProfileSectionMock).toHaveBeenCalledWith(
      { canChangePassword: true, profile },
      undefined,
    );
    expect(screen.getByText('Change password')).toBeInTheDocument();
  });

  it('renders password enrollment for OAuth-only users', () => {
    render(
      <PersonalSettingsPage
        canChangePassword={false}
        canSetPassword={true}
        profile={profile}
      />,
    );

    expect(userProfileSectionMock).toHaveBeenCalledWith(
      { canChangePassword: false, profile },
      undefined,
    );
    expect(screen.getByText('Change password')).toBeInTheDocument();
    expect(changePasswordSectionMock).toHaveBeenCalledWith(
      { email: 'ada@example.com', mode: 'set' },
      undefined,
    );
  });
});
