import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const { queryOptionsMock, queryState, refetchMock } = vi.hoisted(() => ({
  queryOptionsMock: vi.fn(() => ({ queryKey: ['sessions.list'] })),
  queryState: {
    data: undefined as
      | {
          sessions: Array<{ id: string; title: string; activityAt: number }>;
        }
      | undefined,
    isPending: false,
    isError: false,
    isFetching: false,
  },
  refetchMock: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ ...queryState, refetch: refetchMock }),
}));

vi.mock('@/hooks/useRecentSessions', () => ({
  useRecentSessions: () => ({
    recentSessionIds: ['session-2', 'missing-session', 'session-1'],
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      list: {
        queryOptions: queryOptionsMock,
      },
    },
  }),
}));

vi.mock('@/lib/formatters', () => ({
  formatDistanceToNowCompact: () => '2m',
}));

vi.mock('@/components/system', () => ({
  ArrowRight: ({ className }: { className?: string }) => (
    <svg aria-hidden="true" className={className} />
  ),
  Button: ({ children }: { children: React.ReactNode }) => children,
  RetryableLoadError: ({
    message,
    isRetrying,
    onRetry,
  }: {
    message: string;
    isRetrying?: boolean;
    onRetry: () => void;
  }) => (
    <div>
      <p>{message}</p>
      <button type="button" disabled={isRetrying} onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className}>loading</div>
  ),
}));

import { RecentSessionsList } from './RecentSessionsList';

describe('RecentSessionsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.data = {
      sessions: [
        { id: 'session-1', title: 'First session', activityAt: 100 },
        { id: 'session-2', title: 'Second session', activityAt: 200 },
      ],
    };
    queryState.isPending = false;
    queryState.isError = false;
    queryState.isFetching = false;
  });

  it('queries recent session ids and renders available sessions in visit order', () => {
    render(<RecentSessionsList enabled={true} />);

    expect(queryOptionsMock).toHaveBeenCalledWith(
      {
        ids: ['session-2', 'missing-session', 'session-1'],
        limit: 15,
      },
      { enabled: true },
    );
    expect(
      screen
        .getAllByRole('link')
        .slice(0, 2)
        .map((link) => link.textContent),
    ).toEqual(['Second session2m', 'First session2m']);
    expect(
      screen.getByRole('link', { name: /Second session/ }),
    ).toHaveAttribute('href', '/sessions/session-2');
    expect(screen.getByRole('link', { name: /All sessions/ })).toHaveAttribute(
      'href',
      '/sessions',
    );
  });

  it('does not enable the query while the bottom sheet is closed', () => {
    render(<RecentSessionsList enabled={false} />);

    expect(queryOptionsMock).toHaveBeenCalledWith(expect.anything(), {
      enabled: false,
    });
  });

  it('distinguishes a successful empty response from an initial failure', () => {
    queryState.data = { sessions: [] };

    const { rerender } = render(<RecentSessionsList enabled={true} />);
    expect(screen.getByText(/No recent sessions/)).toBeInTheDocument();

    queryState.data = undefined;
    queryState.isError = true;
    rerender(<RecentSessionsList enabled={true} />);

    expect(
      screen.getByText('Failed to load recent sessions.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No recent sessions/)).not.toBeInTheDocument();
  });

  it('retries repeated failures, disables Retry while pending, and recovers', () => {
    queryState.data = undefined;
    queryState.isError = true;

    const { rerender } = render(<RecentSessionsList enabled={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchMock).toHaveBeenCalledTimes(1);

    queryState.isFetching = true;
    rerender(<RecentSessionsList enabled={true} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();

    queryState.isFetching = false;
    rerender(<RecentSessionsList enabled={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchMock).toHaveBeenCalledTimes(2);

    queryState.isError = false;
    queryState.data = {
      sessions: [
        { id: 'session-2', title: 'Recovered session', activityAt: 200 },
      ],
    };
    rerender(<RecentSessionsList enabled={true} />);
    expect(screen.getByText('Recovered session')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load recent sessions.'),
    ).not.toBeInTheDocument();
  });

  it('keeps cached sessions visible when a refetch fails', () => {
    queryState.isError = true;

    render(<RecentSessionsList enabled={true} />);

    expect(screen.getByText('Second session')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load recent sessions.'),
    ).not.toBeInTheDocument();
  });
});
