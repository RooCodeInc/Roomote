import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { userProfileSectionMock } = vi.hoisted(() => ({
  userProfileSectionMock: vi.fn(),
}));

vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/settings/UserProfileSection', () => ({
  UserProfileSection: userProfileSectionMock,
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
  });

  it('passes credential editing availability to the user profile section', () => {
    render(<PersonalSettingsPage canChangePassword={true} profile={profile} />);

    expect(screen.getByText('User profile')).toBeInTheDocument();
    expect(userProfileSectionMock).toHaveBeenCalledWith(
      { canChangePassword: true, profile },
      undefined,
    );
  });

  it('keeps OAuth-only credential editing inside the user profile contract', () => {
    render(
      <PersonalSettingsPage canChangePassword={false} profile={profile} />,
    );

    expect(userProfileSectionMock).toHaveBeenCalledWith(
      { canChangePassword: false, profile },
      undefined,
    );
  });
});
