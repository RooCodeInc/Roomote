import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { invalidateQueriesMock, toastWarningMock } = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn().mockResolvedValue(undefined),
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
          setupSatisfied: false,
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
  useDiscordLinkedAccount: () => ({ data: { mapping: null } }),
}));

vi.mock('@/components/settings/DiscordSetupStatus', () => ({
  DiscordSetupStatus: () => <div>Connect Discord server</div>,
}));

vi.mock('./ProviderSetupExperience', () => ({
  ProviderSetupExperience: () => <div>Discord setup form</div>,
  getSetupVisibleFields: (provider: { fields: unknown[] }) => provider.fields,
  getSetupEffectiveFieldValue: () => 'configured-token',
  getSetupSubmitValues: () => ({}),
}));

import { StepDiscordSetup } from './StepDiscordSetup';

describe('StepDiscordSetup', () => {
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
    expect(screen.getByText('Connect Discord server')).toBeInTheDocument();
  });
});
