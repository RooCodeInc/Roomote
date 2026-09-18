import { act, fireEvent, render, screen } from '@testing-library/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DiscordDefaultChannelPicker } from './DiscordDefaultChannelPicker';

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    comms: {
      listDiscordGuilds: {
        queryOptions: () => ({ queryKey: ['guilds'] }),
        queryKey: () => ['guilds'],
      },
      listDiscordChannels: {
        queryOptions: (input: { guildId: string }, options: object) => ({
          queryKey: ['channels', input.guildId],
          ...options,
        }),
      },
      selectDiscordDestination: {
        mutationOptions: (options: object) => options,
      },
      status: { queryKey: () => ['status'] },
    },
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useMutation: vi.fn(),
    useQuery: vi.fn(),
    useQueryClient: vi.fn(),
  };
});

let channelsPending = true;

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.getClientRects = () =>
    [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
});

beforeEach(() => {
  channelsPending = true;
  vi.mocked(useQueryClient).mockReturnValue({
    invalidateQueries: vi.fn(),
  } as never);
  vi.mocked(useMutation).mockReturnValue({
    isPending: false,
    mutate: vi.fn(),
  } as never);
  vi.mocked(useQuery).mockImplementation((options) => {
    if (options.queryKey[0] === 'guilds') {
      return {
        data: {
          guilds: [
            { id: 'guild-1', name: 'Server one', defaultChannelId: null },
            { id: 'guild-2', name: 'Server two', defaultChannelId: null },
          ],
        },
        isPending: false,
        isError: false,
      } as never;
    }

    return {
      data: channelsPending
        ? undefined
        : {
            channels: [
              {
                id: 'channel-1',
                name: 'updates',
                kind: 'text',
                supported: true,
              },
            ],
          },
      isPending: channelsPending,
      isError: false,
    } as never;
  });
});

async function flushCloseAutoFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('DiscordDefaultChannelPicker focus handoff', () => {
  it('waits for channels to load, then opens the required channel Select', async () => {
    const { rerender } = render(<DiscordDefaultChannelPicker />);

    const serverSelect = screen.getAllByRole('combobox')[0]!;
    fireEvent.click(serverSelect);
    fireEvent.click(screen.getByRole('option', { name: 'Server two' }));
    await flushCloseAutoFocus();

    const channelSelect = screen.getAllByRole('combobox')[1]!;
    expect(channelSelect).toBeDisabled();
    expect(channelSelect).toHaveAttribute('aria-expanded', 'false');

    channelsPending = false;
    rerender(<DiscordDefaultChannelPicker />);
    await flushCloseAutoFocus();

    expect(channelSelect).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('option', { name: '#updates' }),
    ).toBeInTheDocument();
  });
});
