import { render, screen } from '@testing-library/react';

import { SessionNavigationStateProvider } from '@/hooks/useSessionNavigationState';

import { RecentSessions } from './RecentSessions';

const { listInput, listOptions, pathnameState, sessionsState } = vi.hoisted(
  () => ({
    listInput: { value: null as unknown },
    listOptions: { value: null as unknown },
    pathnameState: { value: '/sessions/session-b' },
    sessionsState: {
      value: [
        {
          id: 'session-a',
          title: 'First session',
          cachedStatus: 'needs_input',
          unread: false,
        },
        {
          id: 'session-b',
          title: 'Current session',
          cachedStatus: 'active',
          unread: false,
        },
        {
          id: 'session-c',
          title: 'Unread result',
          cachedStatus: 'ready',
          unread: true,
        },
      ],
    },
  }),
);

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({
    data: { sessions: sessionsState.value },
    refetch: vi.fn(),
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      list: {
        queryOptions: (input: unknown, options: unknown) => {
          listInput.value = input;
          listOptions.value = options;
          return { queryKey: ['sessions', 'list'] };
        },
      },
    },
  }),
}));

describe('RecentSessions', () => {
  beforeEach(() => {
    pathnameState.value = '/sessions/session-b';
  });

  it('keeps server order, active state, and useful attention cues', () => {
    render(
      <SessionNavigationStateProvider>
        <RecentSessions enabled />
      </SessionNavigationStateProvider>,
    );

    expect(listInput.value).toEqual({ ownedOnly: true, limit: 20 });
    expect(listOptions.value).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(
      screen.getByRole('heading', { name: 'Recent sessions' }),
    ).toBeVisible();
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'First session',
      'Current session',
      'Unread result',
    ]);
    expect(
      screen.getByRole('link', { name: 'Current session' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByLabelText('Needs attention')).toHaveLength(2);
    expect(screen.getByLabelText('Running')).toBeVisible();
  });

  it('keeps recent sessions available outside a session route', () => {
    pathnameState.value = '/settings';

    render(
      <SessionNavigationStateProvider>
        <RecentSessions enabled />
      </SessionNavigationStateProvider>,
    );

    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.getByText('Current session')).toBeVisible();
    expect(
      screen.queryByRole('link', { current: 'page' }),
    ).not.toBeInTheDocument();
  });
});
