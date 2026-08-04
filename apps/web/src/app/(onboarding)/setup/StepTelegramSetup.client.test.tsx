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
          id: 'telegram',
          label: 'Telegram',
          fields: [
            {
              envVarName: 'R_TELEGRAM_BOT_TOKEN',
              acceptedEnvVarNames: ['R_TELEGRAM_BOT_TOKEN'],
              label: 'Telegram Bot Token',
              secret: true,
              runtimeSatisfied: true,
              savedSatisfied: false,
              satisfiedByEnvVarName: 'R_TELEGRAM_BOT_TOKEN',
            },
          ],
          runtimeSatisfied: true,
          savedSatisfied: false,
          setupSatisfied: false,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useMutation: (options: {
    onSuccess?: (result: unknown) => Promise<void>;
  }) => ({
    isPending: false,
    mutate: () => {
      if (options.onSuccess) {
        void options.onSuccess({
          telegramWebhook: { registered: false, error: 'network unavailable' },
        });
      }
    },
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
      telegram: { queryKey: () => ['linkedAccounts.telegram'] },
    },
    setupNew: {
      trackCommsState: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useTelegramLinkedAccount: () => ({ data: { mapping: null } }),
}));

vi.mock('@/components/settings/TelegramLinkAccountStep', () => ({
  TelegramLinkAccountStep: () => <div>Link Telegram account</div>,
}));

vi.mock('./ProviderSetupExperience', () => ({
  ProviderSetupExperience: () => <div>Telegram setup form</div>,
  getSetupVisibleFields: (provider: { fields: unknown[] }) => provider.fields,
  getSetupEffectiveFieldValue: () => 'configured-token',
  getSetupSubmitValues: () => ({}),
}));

import { StepTelegramSetup } from './StepTelegramSetup';

describe('StepTelegramSetup', () => {
  it('warns about webhook failure and refreshes linking state after save', async () => {
    render(<StepTelegramSetup onContinue={vi.fn()} onBack={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Save and link account' }),
    );

    await waitFor(() => {
      expect(toastWarningMock).toHaveBeenCalledWith(
        expect.stringContaining('network unavailable'),
      );
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['comms.status'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['linkedAccounts.telegram'],
    });
    expect(screen.getByText('Link Telegram account')).toBeInTheDocument();
  });
});
