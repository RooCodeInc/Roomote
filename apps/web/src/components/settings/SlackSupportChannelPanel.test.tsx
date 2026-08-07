import { fireEvent, render, screen } from '@testing-library/react';

import { SlackSupportChannelPanel } from './SlackSupportChannelPanel';

const state = vi.hoisted(() => ({
  status: {
    eligible: true,
    configured: true,
    state: 'not_started' as
      | 'not_started'
      | 'needs_permissions'
      | 'invitation_pending',
    channelId: null as string | null,
    channelName: null as string | null,
    openUrl: null as string | null,
    message: 'Create a private Slack Connect channel with Roomote support.',
  },
}));

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.status, isPending: false }),
  useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    slack: {
      supportChannel: {
        queryOptions: () => ({}),
        queryKey: () => ['slack', 'supportChannel'],
      },
      createSupportChannel: {
        mutationOptions: (options: unknown) => options,
      },
    },
  }),
}));

describe('SlackSupportChannelPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.status = {
      eligible: true,
      configured: true,
      state: 'not_started',
      channelId: null,
      channelName: null,
      openUrl: null,
      message: 'Create a private Slack Connect channel with Roomote support.',
    };
  });

  it('requires confirmation before creating the external channel', () => {
    render(<SlackSupportChannelPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
    expect(
      screen.getByRole('heading', {
        name: 'Create a shared support channel?',
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and invite' }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('shows the narrow permission upgrade when re-auth is required', () => {
    state.status = {
      ...state.status,
      state: 'needs_permissions',
      message: 'Update the Slack app permissions and re-authenticate.',
    };

    render(<SlackSupportChannelPanel />);

    expect(screen.getByText('groups:write')).toBeInTheDocument();
    expect(screen.getByText('conversations.connect:write')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create channel' }),
    ).not.toBeInTheDocument();
  });
});
