import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type InviteSummary = {
  id: string;
  label: string | null;
  role: 'admin' | 'member';
  maxUses: number;
  usedCount: number;
  acceptedUserCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  usable: boolean;
};

type UserSummary = {
  id: string;
  name: string;
  email: string;
  imageUrl: string;
  role: 'admin' | 'member';
  createdAt: Date;
  hasCredentialAccount?: boolean;
};

type LicenseSummary = {
  status: 'unlicensed' | 'invalid' | 'valid' | 'expired';
  seatLimit: number;
  seatsUsed: number;
  freeSeatLimit: number;
  licensee: string | null;
  expiresAt: Date | null;
  fromEnv: boolean;
};

const unlicensedLicense: LicenseSummary = {
  status: 'unlicensed',
  seatLimit: 10,
  seatsUsed: 1,
  freeSeatLimit: 10,
  licensee: null,
  expiresAt: null,
  fromEnv: false,
};

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve: resolve!,
    reject: reject!,
  };
}

const {
  mockSettingsState,
  mockCreateInvite,
  mockRevokeInvite,
  mockUpdateUserRole,
  mockRemoveUser,
  mockCreatePasswordResetLink,
  mockSetLicenseKey,
  mockClipboardWriteText,
} = vi.hoisted(() => ({
  mockSettingsState: {
    current: {
      slackTeamId: null as string | null,
      hasSlackSignIn: false,
      hasMicrosoftSignIn: false,
      invites: [] as InviteSummary[],
      users: [] as UserSummary[],
      license: {
        status: 'unlicensed',
        seatLimit: 10,
        seatsUsed: 1,
        freeSeatLimit: 10,
        licensee: null,
        expiresAt: null,
        fromEnv: false,
      } as LicenseSummary,
    },
  },
  mockCreateInvite: vi.fn(
    async (input: { label?: string; maxUses?: number }) => {
      mockSettingsState.current = {
        ...mockSettingsState.current,
        invites: [
          {
            id: 'invite-1',
            label: input.label ?? null,
            role: 'member',
            maxUses: input.maxUses ?? 1,
            usedCount: 0,
            acceptedUserCount: 0,
            expiresAt: null,
            revokedAt: null,
            createdAt: new Date('2026-07-02T00:00:00Z'),
            usable: true,
          },
          ...mockSettingsState.current.invites,
        ],
      };
      return {
        inviteId: 'invite-1',
        url: 'https://roomote.example.com/invite/new-token',
      };
    },
  ),
  mockRevokeInvite: vi.fn(async (input: { inviteId: string }) => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      invites: mockSettingsState.current.invites.map((invite) =>
        invite.id === input.inviteId
          ? {
              ...invite,
              revokedAt: new Date('2026-07-02T00:00:00Z'),
              usable: false,
            }
          : invite,
      ),
    };

    return { revoked: true };
  }),
  mockUpdateUserRole: vi.fn(
    async (_input: { userId: string; role: 'admin' | 'member' }) => ({
      updated: true,
    }),
  ),
  mockRemoveUser: vi.fn(async (_input: { userId: string }) => ({
    removed: true,
  })),
  mockCreatePasswordResetLink: vi.fn(async (_input: { userId: string }) => ({
    url: 'https://roomote.example.com/api/auth/reset-password/token',
    expiresAt: new Date('2026-07-03T13:00:00Z'),
  })),
  mockSetLicenseKey: vi.fn(async (_input: { licenseKey: string | null }) => ({
    saved: true,
  })),
  mockClipboardWriteText: vi.fn(async (_value: string) => undefined),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ userId: 'user-1' }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    accessPolicy: {
      get: {
        queryKey: () => ['access-policy'],
        queryOptions: () => ({
          queryKey: ['access-policy'],
          queryFn: async () => mockSettingsState.current,
        }),
      },
      createInvite: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          mutationFn: mockCreateInvite,
          ...options,
        }),
      },
      revokeInvite: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          mutationFn: mockRevokeInvite,
          ...options,
        }),
      },
      updateUserRole: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          mutationFn: mockUpdateUserRole,
          ...options,
        }),
      },
      removeUser: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          mutationFn: mockRemoveUser,
          ...options,
        }),
      },
      createPasswordResetLink: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          mutationFn: mockCreatePasswordResetLink,
          ...options,
        }),
      },
      setLicenseKey: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          mutationFn: mockSetLicenseKey,
          ...options,
        }),
      },
    },
  }),
}));

import { UsersSettings } from './UsersSettings';
import { toast } from 'sonner';

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: mockClipboardWriteText,
  },
});

function renderUsersSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <UsersSettings />
    </QueryClientProvider>,
  );
}

describe('UsersSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClipboardWriteText.mockResolvedValue(undefined);
    mockSettingsState.current = {
      slackTeamId: null,
      hasSlackSignIn: false,
      hasMicrosoftSignIn: false,
      invites: [],
      users: [],
      license: unlicensedLicense,
    };
  });

  it('shows org membership rows only for configured org providers', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      slackTeamId: 'T123',
      hasSlackSignIn: true,
    };

    renderUsersSettings();

    expect(
      await screen.findByText(/Any user in your Slack workspace/),
    ).toBeInTheDocument();
    expect(screen.getByText('(T123)')).toBeInTheDocument();
    expect(
      screen.queryByText(/Microsoft Teams account/),
    ).not.toBeInTheDocument();
  });

  it('creates an invite and shows the one-time link', async () => {
    renderUsersSettings();

    const labelInput = await screen.findByLabelText(/Label/);
    fireEvent.change(labelInput, { target: { value: 'Design team' } });

    const usesInput = screen.getByLabelText('Uses');
    fireEvent.change(usesInput, { target: { value: '5' } });

    fireEvent.click(screen.getByRole('button', { name: /Create invite/ }));

    expect(
      await screen.findByText('https://roomote.example.com/invite/new-token'),
    ).toBeInTheDocument();
    expect(mockCreateInvite.mock.calls[0]?.[0]).toMatchObject({
      label: 'Design team',
      maxUses: 5,
    });
    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith(
        'https://roomote.example.com/invite/new-token',
      );
      expect(toast.success).toHaveBeenCalledWith(
        'Invite link created and copied to the clipboard',
      );
    });
  });

  it('submits the invite creation form', async () => {
    renderUsersSettings();

    const labelInput = await screen.findByLabelText(/Label/);
    fireEvent.change(labelInput, { target: { value: 'Support team' } });
    fireEvent.submit(labelInput.closest('form')!);

    await waitFor(() => {
      expect(mockCreateInvite).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith(
        'Invite link created and copied to the clipboard',
      );
    });
    expect(mockCreateInvite.mock.calls[0]?.[0]).toMatchObject({
      label: 'Support team',
    });
  });

  it('lists only non-revoked invites and removes revoked ones', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      invites: [
        {
          id: 'invite-1',
          label: 'Design team',
          role: 'admin',
          maxUses: 5,
          usedCount: 2,
          acceptedUserCount: 2,
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          usable: true,
        },
        {
          id: 'invite-2',
          label: 'Old link',
          role: 'member',
          maxUses: 1,
          usedCount: 1,
          acceptedUserCount: 1,
          expiresAt: null,
          revokedAt: new Date('2026-07-01T00:00:00Z'),
          createdAt: new Date('2026-06-01T00:00:00Z'),
          usable: false,
        },
      ],
    };

    renderUsersSettings();

    expect(
      await screen.findByText('Invite for Design team'),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 of 5 used/)).toBeInTheDocument();
    expect(screen.queryByText('Invite for Old link')).not.toBeInTheDocument();
    expect(screen.queryByText('revoked')).not.toBeInTheDocument();
    // The admin invite is badged; the member invite is not.
    expect(
      within(
        screen.getByText('Invite for Design team').closest('p')!,
      ).getByText('Admin'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Revoke invite Old link'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Revoke invite Design team'));

    expect(
      await screen.findByRole('button', { name: 'Delete' }),
    ).toBeInTheDocument();
    expect(mockRevokeInvite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockRevokeInvite).toHaveBeenCalledTimes(1);
    });
    expect(mockRevokeInvite.mock.calls[0]?.[0]).toMatchObject({
      inviteId: 'invite-1',
    });
    await waitFor(() => {
      expect(
        screen.queryByText('Invite for Design team'),
      ).not.toBeInTheDocument();
    });
  });

  it('restores an optimistically removed invite when revoking fails', async () => {
    const deferredRevoke = createDeferred<{ revoked: boolean }>();
    mockRevokeInvite.mockReturnValueOnce(deferredRevoke.promise);
    mockSettingsState.current = {
      ...mockSettingsState.current,
      invites: [
        {
          id: 'invite-1',
          label: 'Design team',
          role: 'admin',
          maxUses: 5,
          usedCount: 2,
          acceptedUserCount: 2,
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          usable: true,
        },
        {
          id: 'invite-2',
          label: 'Engineering',
          role: 'member',
          maxUses: 10,
          usedCount: 0,
          acceptedUserCount: 0,
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          usable: true,
        },
      ],
    };

    renderUsersSettings();

    expect(
      await screen.findByText('Invite for Design team'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Revoke invite Design team'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(
        screen.queryByText('Invite for Design team'),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Revoke invite Engineering')).toBeEnabled();

    await act(async () => {
      deferredRevoke.reject(new Error('Unable to delete invite.'));
      await deferredRevoke.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(screen.getByText('Invite for Design team')).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('Unable to delete invite.');
    });
  });

  it('lists users', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      users: [
        {
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          imageUrl: '',
          role: 'admin',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
        {
          id: 'user-2',
          name: 'Grace Hopper',
          email: 'grace@example.com',
          imageUrl: 'https://example.com/grace.png',
          role: 'member',
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      ],
    };

    renderUsersSettings();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('grace@example.com')).toBeInTheDocument();
  });

  it('locks role controls for your own row and shows current roles', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      users: [
        {
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          imageUrl: '',
          role: 'admin',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
        {
          id: 'user-2',
          name: 'Grace Hopper',
          email: 'grace@example.com',
          imageUrl: '',
          role: 'member',
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      ],
    };

    renderUsersSettings();

    const ownRoleSelect = await screen.findByRole('combobox', {
      name: 'Role for Ada Lovelace',
    });
    const otherRoleSelect = screen.getByRole('combobox', {
      name: 'Role for Grace Hopper',
    });

    expect(ownRoleSelect).toBeDisabled();
    expect(ownRoleSelect).toHaveTextContent('Admin');
    expect(otherRoleSelect).toBeEnabled();
    expect(otherRoleSelect).toHaveTextContent('Member');
  });

  it('removes another user after confirmation and never yourself', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      users: [
        {
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          imageUrl: '',
          role: 'admin',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
        {
          id: 'user-2',
          name: 'Grace Hopper',
          email: 'grace@example.com',
          imageUrl: '',
          role: 'member',
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      ],
    };

    renderUsersSettings();

    expect(await screen.findByLabelText('Remove Ada Lovelace')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Remove Grace Hopper'));

    expect(
      await screen.findByRole('button', { name: 'Remove' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(mockRemoveUser).toHaveBeenCalledTimes(1);
    });
    expect(mockRemoveUser.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-2',
    });
  });

  it('creates a password reset link for credential users only', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      users: [
        {
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          imageUrl: '',
          role: 'admin',
          createdAt: new Date('2026-06-01T00:00:00Z'),
          hasCredentialAccount: false,
        },
        {
          id: 'user-2',
          name: 'Grace Hopper',
          email: 'grace@example.com',
          imageUrl: '',
          role: 'member',
          createdAt: new Date('2026-07-01T00:00:00Z'),
          hasCredentialAccount: true,
        },
      ],
    };

    renderUsersSettings();

    expect(
      await screen.findByLabelText('Reset password for Ada Lovelace'),
    ).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Reset password for Grace Hopper'));

    expect(
      await screen.findByRole('button', { name: 'Create link' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    expect(
      await screen.findByText(
        'https://roomote.example.com/api/auth/reset-password/token',
      ),
    ).toBeInTheDocument();
    expect(mockCreatePasswordResetLink.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-2',
    });
    expect(mockClipboardWriteText).toHaveBeenCalledWith(
      'https://roomote.example.com/api/auth/reset-password/token',
    );
    expect(screen.getByLabelText('Copy password reset link')).toBeEnabled();
  });

  it('shows seat usage and saves a license key', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      license: { ...unlicensedLicense, seatsUsed: 4 },
    };

    renderUsersSettings();

    expect(await screen.findByText('4 of 10 seats used')).toBeInTheDocument();
    expect(screen.getByText('Free tier')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove key' }),
    ).not.toBeInTheDocument();

    const saveButton = screen.getByRole('button', { name: 'Save key' });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('License key'), {
      target: { value: 'RMLK1.payload.signature' },
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockSetLicenseKey.mock.calls[0]?.[0]).toMatchObject({
        licenseKey: 'RMLK1.payload.signature',
      });
    });
    expect(toast.success).toHaveBeenCalledWith('License key saved.');
  });

  it('shows licensed state, at-limit warning, and removes the key', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      license: {
        status: 'valid',
        seatLimit: 25,
        seatsUsed: 25,
        freeSeatLimit: 10,
        licensee: 'Acme Corp',
        expiresAt: null,
        fromEnv: false,
      },
    };

    renderUsersSettings();

    expect(await screen.findByText('Licensed')).toBeInTheDocument();
    expect(screen.getByText('25 of 25 seats used')).toBeInTheDocument();
    expect(screen.getByText(/Licensed to Acme Corp/)).toBeInTheDocument();
    expect(screen.getByText(/All seats are in use/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));

    await waitFor(() => {
      expect(mockSetLicenseKey.mock.calls[0]?.[0]).toMatchObject({
        licenseKey: null,
      });
    });
    expect(toast.success).toHaveBeenCalledWith('License key removed.');
  });

  it('hides the license key form when the key is provided by R_LICENSE_KEY', async () => {
    mockSettingsState.current = {
      ...mockSettingsState.current,
      license: {
        status: 'valid',
        seatLimit: 50,
        seatsUsed: 4,
        freeSeatLimit: 10,
        licensee: 'Acme Corp',
        expiresAt: null,
        fromEnv: true,
      },
    };

    renderUsersSettings();

    expect(await screen.findByText('Licensed')).toBeInTheDocument();
    expect(
      screen.getByText((_content, element) => {
        return (
          element?.tagName === 'P' &&
          (element.textContent ?? '').includes(
            'License key is provided by the R_LICENSE_KEY environment variable',
          )
        );
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('License key')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save key' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove key' }),
    ).not.toBeInTheDocument();
  });
});
