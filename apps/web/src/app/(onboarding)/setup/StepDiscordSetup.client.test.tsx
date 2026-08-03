import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  invalidateQueriesMock,
  linkedAccountState,
  providerSetupState,
  toastWarningMock,
} = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn().mockResolvedValue(undefined),
  linkedAccountState: { mapping: null as { discordUserId: string } | null },
  providerSetupState: { satisfied: false },
  toastWarningMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: toastWarningMock },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      providers: [
        {
          id: 'discord',
          label: 'Discord',
          fields: [
            {
              envVarName: 'R_DISCORD_BOT_TOKEN',
              acceptedEnvVarNames: ['R_DISCORD_BOT_TOKEN'],
              label: 'Discord Bot Token',
              secret: true,
              runtimeSatisfied: true,
              savedSatisfied: false,
              satisfiedByEnvVarName: 'R_DISCORD_BOT_TOKEN',
            },
          ],
          runtimeSatisfied: true,
          savedSatisfied: false,
          setupSatisfied: providerSetupState.satisfied,
          discord: {
            installations: [],
          },
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useMutation: (options: {
    onSuccess: (result: unknown) => Promise<void>;
  }) => ({
    isPending: false,
    mutate: () =>
      void options.onSuccess({
        telegramWebhook: null,
        discord: { registered: false, error: 'gateway unavailable' },
      }),
  }),
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    comms: {
      status: {
        queryOptions: () => ({}),
        queryKey: () => ['comms.status'],
      },
      saveAuthConfig: { mutationOptions: (options: unknown) => options },
    },
    linkedAccounts: {
      discord: { queryKey: () => ['linkedAccounts.discord'] },
    },
  }),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useDiscordLinkedAccount: () => ({ data: linkedAccountState }),
}));

vi.mock('@/components/settings/DiscordLinkAccountStep', () => ({
  DiscordLinkAccountStep: () => <div>Link Discord account step</div>,
}));

vi.mock('./ProviderSetupExperience', () => ({
  ProviderSetupExperience: () => <div>Discord setup form</div>,
  getSetupVisibleFields: (provider: { fields: unknown[] }) => provider.fields,
  getSetupEffectiveFieldValue: () => 'configured-token',
  getSetupSubmitValues: () => ({}),
}));

import { StepDiscordSetup } from './StepDiscordSetup';

describe('StepDiscordSetup', () => {
  beforeEach(() => {
    linkedAccountState.mapping = null;
    providerSetupState.satisfied = false;
  });

  it('shows only account linking when Discord is already configured', () => {
    providerSetupState.satisfied = true;

    render(<StepDiscordSetup onContinue={vi.fn()} onBack={vi.fn()} />);

    expect(
      screen.getByRole('heading', { name: 'Link Discord Account' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Link Discord account step')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Save and connect Discord' }),
    ).not.toBeInTheDocument();
  });

  it('warns when connection finishing fails and refreshes setup state', async () => {
    render(<StepDiscordSetup onContinue={vi.fn()} onBack={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Save and connect Discord' }),
    );

    await waitFor(() => {
      expect(toastWarningMock).toHaveBeenCalledWith(
        expect.stringContaining('gateway unavailable'),
      );
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['comms.status'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['linkedAccounts.discord'],
    });
    expect(
      screen.getByRole('heading', { name: 'Link Discord Account' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Link Discord account step')).toBeInTheDocument();
  });

  it('continues after account linking without requiring a destination', async () => {
    linkedAccountState.mapping = { discordUserId: 'discord-user-1' };
    const onContinue = vi.fn();
    render(<StepDiscordSetup onContinue={onContinue} onBack={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Save and connect Discord' }),
    );

    const continueButton = await screen.findByRole('button', {
      name: 'Continue',
    });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
