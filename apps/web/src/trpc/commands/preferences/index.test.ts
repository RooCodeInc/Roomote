const { setPasswordMock, userHasCredentialAccountMock } = vi.hoisted(() => ({
  setPasswordMock: vi.fn(),
  userHasCredentialAccountMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  eq: vi.fn(),
  users: {},
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ cookie: 'session=example' }),
}));

vi.mock('@/lib/server/auth', () => ({
  getAuth: async () => ({
    api: { setPassword: setPasswordMock },
  }),
}));

vi.mock('@/lib/server/user-management', () => ({
  userHasCredentialAccount: userHasCredentialAccountMock,
}));

import {
  getPersonalAccountCapabilitiesCommand,
  setPersonalPasswordCommand,
} from './index';

const auth = { userId: 'user-1' } as never;

describe('personal account capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers password enrollment to OAuth-only users', async () => {
    userHasCredentialAccountMock.mockResolvedValue(false);

    await expect(getPersonalAccountCapabilitiesCommand(auth)).resolves.toEqual({
      canChangePassword: false,
      canSetPassword: true,
      communicationsFastModeDefaultAvailable: false,
    });
  });

  it('offers password changes to credential users', async () => {
    userHasCredentialAccountMock.mockResolvedValue(true);

    await expect(getPersonalAccountCapabilitiesCommand(auth)).resolves.toEqual({
      canChangePassword: true,
      canSetPassword: false,
      communicationsFastModeDefaultAvailable: false,
    });
  });

  it('delegates password enrollment to Better Auth with the active session', async () => {
    await setPersonalPasswordCommand(auth, 'new-password');

    expect(setPasswordMock).toHaveBeenCalledWith({
      body: { newPassword: 'new-password' },
      headers: expect.any(Headers),
    });
  });
});
