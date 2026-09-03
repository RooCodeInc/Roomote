import React from 'react';
import { render, screen } from '@testing-library/react';

const { queryOptionsMock, useQueryMock } = vi.hoisted(() => ({
  queryOptionsMock: vi.fn(() => ({ queryKey: ['sessions.list'] })),
  useQueryMock: vi.fn(),
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
  useQuery: (options: unknown) => useQueryMock(options),
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
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className}>loading</div>
  ),
}));

import { RecentSessionsList } from './RecentSessionsList';

describe('RecentSessionsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueryMock.mockReturnValue({
      data: {
        sessions: [
          { id: 'session-1', title: 'First session', activityAt: 100 },
          { id: 'session-2', title: 'Second session', activityAt: 200 },
        ],
      },
      isPending: false,
    });
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
});
