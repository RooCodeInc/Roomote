import { render, screen } from '@testing-library/react';

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      recentPullRequests: {
        queryOptions: () => ({ queryKey: ['tasks.recentPullRequests'] }),
      },
    },
  }),
}));

vi.mock('./PullRequestsList', () => ({
  PullRequestsList: () => <div>Pull requests</div>,
}));

vi.mock('./RecentSessionsList', () => ({
  RecentSessionsList: () => <div>Recent sessions</div>,
}));

import { BottomSheetTabs } from './BottomSheetTabs';

beforeEach(() => {
  useQueryMock.mockReturnValue({ data: undefined });
});

it('renders the home tabs', () => {
  render(<BottomSheetTabs />);

  expect(
    screen.getByRole('button', { name: 'Recent Sessions' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Recent PRs' }),
  ).toBeInTheDocument();
});

it('shows the loaded open PR count before the tab is selected', () => {
  useQueryMock.mockReturnValue({
    data: { pullRequests: [], openCount: 23 },
  });

  render(<BottomSheetTabs />);

  expect(
    screen.getByRole('button', { name: 'Recent PRs (23)' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('Pull requests')).not.toBeInTheDocument();
});

it('shows a loaded zero but no count while loading or after an error', () => {
  useQueryMock.mockReturnValue({
    data: { pullRequests: [], openCount: 0 },
  });

  const { rerender } = render(<BottomSheetTabs />);
  expect(
    screen.getByRole('button', { name: 'Recent PRs (0)' }),
  ).toBeInTheDocument();

  useQueryMock.mockReturnValue({ data: undefined, isError: true });
  rerender(<BottomSheetTabs />);

  expect(
    screen.getByRole('button', { name: 'Recent PRs' }),
  ).toBeInTheDocument();
});
