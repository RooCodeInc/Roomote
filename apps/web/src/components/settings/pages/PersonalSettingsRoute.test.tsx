import { render } from '@testing-library/react';

let accountCapabilities:
  | {
      canChangePassword: boolean;
      canSetPassword: boolean;
      communicationsFastModeDefaultAvailable: boolean;
    }
  | undefined = {
  canChangePassword: true,
  canSetPassword: false,
  communicationsFastModeDefaultAvailable: true,
};

const { personalSettingsPageMock } = vi.hoisted(() => ({
  personalSettingsPageMock: vi.fn(() => <div>Personal settings</div>),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: accountCapabilities }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    name: 'Ada Lovelace',
    primaryEmail: 'ada@example.com',
    resource: { imageUrl: 'https://example.com/ada.png' },
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    preferences: {
      accountCapabilities: {
        queryOptions: () => ({}),
      },
    },
  }),
}));

vi.mock('./PersonalSettingsPage', () => ({
  PersonalSettingsPage: personalSettingsPageMock,
}));

import { PersonalSettingsRoute } from './PersonalSettingsRoute';

describe('PersonalSettingsRoute', () => {
  beforeEach(() => {
    accountCapabilities = {
      canChangePassword: true,
      canSetPassword: false,
      communicationsFastModeDefaultAvailable: true,
    };
    personalSettingsPageMock.mockClear();
  });

  it('renders the profile from the existing authorized-user context', () => {
    render(<PersonalSettingsRoute />);

    expect(personalSettingsPageMock).toHaveBeenCalledWith(
      {
        canChangePassword: true,
        canSetPassword: false,
        communicationsFastModeDefaultAvailable: true,
        profile: {
          email: 'ada@example.com',
          imageUrl: 'https://example.com/ada.png',
          name: 'Ada Lovelace',
        },
      },
      undefined,
    );
  });

  it('renders immediately while account capabilities load', () => {
    accountCapabilities = undefined;

    render(<PersonalSettingsRoute />);

    expect(personalSettingsPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        canChangePassword: false,
        canSetPassword: false,
      }),
      undefined,
    );
  });
});
