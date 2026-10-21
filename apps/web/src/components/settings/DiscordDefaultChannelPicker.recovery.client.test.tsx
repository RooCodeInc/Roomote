import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { DiscordDefaultChannelPicker } from './DiscordDefaultChannelPicker';

const state = vi.hoisted(() => ({
  failed: null as 'guilds' | 'channels' | null,
  gate: null as Promise<void> | null,
  save: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    comms: {
      listDiscordGuilds: {
        queryKey: () => ['guilds'],
        queryOptions: () => ({
          queryKey: ['guilds'],
          queryFn: async () => {
            await state.gate;
            if (state.failed === 'guilds')
              throw new Error('Server read failed');
            return {
              guilds: [
                { id: 'guild-1', name: 'Demo server', defaultChannelId: null },
              ],
            };
          },
        }),
      },
      listDiscordChannels: {
        queryOptions: (input: { guildId: string }, options: object) => ({
          queryKey: ['channels', input.guildId],
          queryFn: async () => {
            await state.gate;
            if (state.failed === 'channels')
              throw new Error('Channel read failed');
            return {
              channels: [
                {
                  id: 'channel-1',
                  name: 'updates',
                  kind: 'text',
                  supported: true,
                },
              ],
            };
          },
          ...options,
        }),
      },
      selectDiscordDestination: {
        mutationOptions: (options: object) => ({
          mutationFn: state.save,
          ...options,
        }),
      },
      status: { queryKey: () => ['status'] },
    },
  }),
}));

function renderPicker() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DiscordDefaultChannelPicker />
    </QueryClientProvider>,
  );
  return client;
}

async function chooseChannel() {
  const picker = await screen.findByRole('combobox');
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole('option', { name: '#updates' }));
}

beforeEach(() => {
  state.failed = null;
  state.gate = null;
  state.save.mockReset();
  state.save.mockResolvedValue({});
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

it.each(['guilds', 'channels'] as const)(
  'recovers an initial %s read failure with the actual query retry',
  async (catalog) => {
    state.failed = catalog;
    renderPicker();
    const kind = catalog === 'guilds' ? 'servers' : 'channels';
    const retry = await screen.findByRole('button', {
      name: `Retry Discord ${kind}`,
    });
    state.failed = null;
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    await chooseChannel();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledExactlyOnceWith(
        { guildId: 'guild-1', channelId: 'channel-1' },
        expect.anything(),
      ),
    );
  },
);

it.each(['guilds', 'channels'] as const)(
  'keeps the selected channel but blocks saves through a background %s failure and retry',
  async (catalog) => {
    const client = renderPicker();
    await chooseChannel();
    state.failed = catalog;
    await act(() => client.refetchQueries({ queryKey: [catalog] }));
    const kind = catalog === 'guilds' ? 'servers' : 'channels';
    const retry = await screen.findByRole('button', {
      name: `Retry Discord ${kind}`,
    });
    expect(screen.getByRole('combobox')).toHaveTextContent('#updates');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
    state.failed = null;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('#updates');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  },
);
