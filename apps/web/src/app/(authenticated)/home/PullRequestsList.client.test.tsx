import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { queryOptionsMock, useQueryMock } = vi.hoisted(() => ({
  queryOptionsMock: vi.fn(() => ({ queryKey: ['tasks.recentPullRequests'] })),
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

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      recentPullRequests: {
        queryOptions: queryOptionsMock,
      },
    },
  }),
}));

vi.mock('@/lib', () => ({
  formatDistanceToNowCompact: () => '2m',
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classNames: Array<string | false | null | undefined>) =>
    classNames.filter(Boolean).join(' '),
}));

vi.mock('@/components/system', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  const TabsContext = React.createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
  }>({});

  function Icon({ className, name }: { className?: string; name: string }) {
    return <svg aria-hidden="true" className={className} data-icon={name} />;
  }

  return {
    ArrowRight: ({ className }: { className?: string }) => (
      <Icon className={className} name="ArrowRight" />
    ),
    Badge: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => <span className={className}>{children}</span>,
    GitPullRequest: ({ className }: { className?: string }) => (
      <Icon className={className} name="GitPullRequest" />
    ),
    GitPullRequestCreateArrow: ({ className }: { className?: string }) => (
      <Icon className={className} name="GitPullRequestCreateArrow" />
    ),
    GitPullRequestDraft: ({ className }: { className?: string }) => (
      <Icon className={className} name="GitPullRequestDraft" />
    ),
    Skeleton: ({ className }: { className?: string }) => (
      <div className={className}>loading</div>
    ),
    Tabs: ({
      children,
      value,
      onValueChange,
      className,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
      className?: string;
    }) => (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div className={className}>{children}</div>
      </TabsContext.Provider>
    ),
    TabsList: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => <div className={className}>{children}</div>,
    TabsTrigger: ({
      children,
      className,
      value,
    }: {
      children: React.ReactNode;
      className?: string;
      value: string;
    }) => {
      const tabs = React.useContext(TabsContext);

      return (
        <button
          type="button"
          className={className}
          data-state={tabs.value === value ? 'active' : 'inactive'}
          onClick={() => tabs.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
  };
});

import { PullRequestsList } from './PullRequestsList';

const pullRequests = [
  {
    repo: 'roomote/app',
    prNumber: 11,
    prTitle: 'Draft PR',
    prUrl: 'https://github.com/roomote/app/pull/11',
    taskId: 'task-draft',
    createdAt: new Date('2026-03-25T10:00:00Z'),
    status: 'draft' as const,
  },
  {
    repo: 'roomote/app',
    prNumber: 12,
    prTitle: 'Ready PR',
    prUrl: 'https://github.com/roomote/app/pull/12',
    taskId: 'task-ready',
    createdAt: new Date('2026-03-25T11:00:00Z'),
    status: 'open' as const,
  },
  {
    repo: 'roomote/app',
    prNumber: 13,
    prTitle: 'Merged PR',
    prUrl: 'https://github.com/roomote/app/pull/13',
    taskId: 'task-merged',
    createdAt: new Date('2026-03-25T12:00:00Z'),
    status: 'merged' as const,
  },
];

describe('PullRequestsList', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useQueryMock.mockReturnValue({
      data: pullRequests,
      isPending: false,
    });
  });

  it('filters pull requests by status and persists the selection', async () => {
    render(<PullRequestsList enabled={true} />);

    expect(screen.getByText('Draft PR')).toBeInTheDocument();
    expect(screen.getByText('Ready PR')).toBeInTheDocument();
    expect(screen.getByText('Merged PR')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Draft/i }));

    await waitFor(() => {
      expect(screen.getByText('Draft PR')).toBeInTheDocument();
      expect(screen.queryByText('Ready PR')).not.toBeInTheDocument();
      expect(screen.queryByText('Merged PR')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem('home-pull-requests-status-filter')).toBe(
      'draft',
    );

    fireEvent.click(screen.getByRole('button', { name: /Ready/i }));

    await waitFor(() => {
      expect(screen.queryByText('Draft PR')).not.toBeInTheDocument();
      expect(screen.getByText('Ready PR')).toBeInTheDocument();
      expect(screen.queryByText('Merged PR')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem('home-pull-requests-status-filter')).toBe(
      'ready',
    );
  });

  it('restores the saved filter from local storage on the initial render', () => {
    localStorage.setItem('home-pull-requests-status-filter', 'draft');

    render(<PullRequestsList enabled={true} />);

    expect(screen.getByRole('button', { name: /Draft/i })).toHaveAttribute(
      'data-state',
      'active',
    );
    expect(screen.getByText('Draft PR')).toBeInTheDocument();
    expect(screen.queryByText('Ready PR')).not.toBeInTheDocument();
    expect(screen.queryByText('Merged PR')).not.toBeInTheDocument();
  });

  it('renders status badges inside the matching pull request entries', () => {
    render(<PullRequestsList enabled={true} />);

    expect(screen.getByText('Draft PR').closest('li')).toHaveTextContent(
      'Draft',
    );
    expect(screen.getByText('Ready PR').closest('li')).toHaveTextContent(
      'Ready',
    );
    expect(screen.getByText('Merged PR').closest('li')).toHaveTextContent(
      'Merged',
    );
  });

  it('keeps the sticky status filters on an opaque layer above the PR rows', () => {
    render(<PullRequestsList enabled={true} />);

    const stickyHeader = screen
      .getByRole('button', { name: /All/i })
      .closest('.sticky');

    expect(stickyHeader).toHaveClass('sticky', 'top-0', 'z-20', 'bg-card');
  });
});
