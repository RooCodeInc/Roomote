import { render, screen, waitFor } from '@testing-library/react';

const { pollMock, startResult } = vi.hoisted(() => ({
  pollMock: vi.fn(),
  startResult: {
    current: {
      deviceAuthId: 'dev-1',
      userCode: 'ABCD-EFGHI',
      verificationUrl: 'https://auth.openai.com/codex/device',
      intervalMs: 5,
      expiresInMs: 60_000,
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/trpc/client', () => {
  const queryKey = () => ['stub'];
  return {
    useTRPC: () => ({
      chatgptSubscription: {
        startDeviceAuth: {
          mutationOptions: (options: Record<string, unknown>) => ({
            mutationKey: ['start'],
            ...options,
          }),
        },
        pollDeviceAuth: { mutationOptions: () => ({ mutationKey: ['poll'] }) },
        status: { queryKey },
      },
      taskModels: {
        providerSetup: { queryKey },
        get: { queryKey },
        launchOptions: { queryKey },
      },
      subscriptionUsage: { list: { queryKey } },
    }),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
  useMutation: (options: {
    mutationKey: string[];
    onSuccess?: (result: unknown) => void;
  }) =>
    options.mutationKey[0] === 'start'
      ? {
          mutate: () => options.onSuccess?.(startResult.current),
          isPending: false,
          isError: false,
          reset: vi.fn(),
        }
      : { mutateAsync: pollMock },
}));

import { ChatGptConnectDialog } from './ChatGptConnectDialog';

describe('ChatGptConnectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startResult.current = {
      deviceAuthId: 'dev-1',
      userCode: 'ABCD-EFGHI',
      verificationUrl: 'https://auth.openai.com/codex/device',
      intervalMs: 5,
      expiresInMs: 60_000,
    };
  });

  it('stops polling and prompts a restart once the device code expires', async () => {
    startResult.current = { ...startResult.current, expiresInMs: 30 };
    pollMock.mockResolvedValue({ status: 'pending' });

    render(<ChatGptConnectDialog open onOpenChange={vi.fn()} />);

    await screen.findByText(/authorization code expired/i);

    const callsAtExpiry = pollMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pollMock.mock.calls.length).toBe(callsAtExpiry);
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });

  it('reports an org policy block instead of waiting forever', async () => {
    pollMock.mockResolvedValue({
      status: 'failed',
      error: 'ChatGPT device authorization was refused (deviceauth_forbidden).',
      reason: 'blocked',
    });

    render(<ChatGptConnectDialog open onOpenChange={vi.fn()} />);

    await screen.findByText(/deviceauth_forbidden/);
    expect(
      screen.getByText(/workspace policy blocks the Codex app/i),
    ).toBeInTheDocument();
    // The dead code is no longer presented as something to type in.
    expect(
      screen.queryByText(/Waiting for authorization/i),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(pollMock).toHaveBeenCalledTimes(1));
  });

  it('surfaces a rejected poll instead of leaving the promise unhandled', async () => {
    pollMock.mockRejectedValue(new Error('network down'));

    render(<ChatGptConnectDialog open onOpenChange={vi.fn()} />);

    await screen.findByText('network down');
    expect(
      screen.queryByText(/Waiting for authorization/i),
    ).not.toBeInTheDocument();
  });
});
