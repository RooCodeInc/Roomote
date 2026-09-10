import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { start, poll } = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn() }));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    githubCopilotSubscription: {
      startDeviceAuth: {
        mutationOptions: (handlers: object) => ({
          mutationFn: start,
          ...handlers,
        }),
      },
      pollDeviceAuth: { mutationOptions: () => ({ mutationFn: poll }) },
      status: { queryKey: () => ['copilot'] },
    },
    taskModels: {
      providerSetup: { queryKey: () => ['setup'] },
      get: { queryKey: () => ['models'] },
      launchOptions: { queryKey: () => ['launch'] },
    },
    subscriptionUsage: { list: { queryKey: () => ['usage'] } },
  }),
}));

import { GitHubCopilotConnectDialog } from './GitHubCopilotConnectDialog';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Connect</button>
      <GitHubCopilotConnectDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('GitHubCopilotConnectDialog recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    start.mockRejectedValue(new Error('Startup unavailable'));
    poll.mockResolvedValue({ status: 'success' });
  });

  it('starts again after canceling a failed start without silently retrying while open', async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Startup unavailable',
    );
    expect(start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole('button', { name: 'Restart' }),
    ).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Startup unavailable');
  });

  it('can explicitly restart a failed start and finish authorization', async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const restart = await screen.findByRole('button', { name: 'Restart' });
    start.mockResolvedValue({
      deviceCode: 'device',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://github.com/login/device',
      intervalMs: 1000,
      expiresInMs: 60000,
    });
    fireEvent.click(restart);
    await waitFor(() =>
      expect(poll).toHaveBeenCalledWith(
        { deviceCode: 'device' },
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(start).toHaveBeenCalledTimes(2);
  });
});
