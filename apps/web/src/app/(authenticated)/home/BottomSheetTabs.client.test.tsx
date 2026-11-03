import { fireEvent, render, screen } from '@testing-library/react';

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
  RecentSessionsList: () => (
    <div>
      Recent sessions<button>Recent session action</button>
    </div>
  ),
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

it('keeps the hidden close control out of keyboard and assistive navigation', () => {
  const { container } = render(<BottomSheetTabs />);

  expect(
    screen.queryByRole('button', { name: 'Close bottom sheet' }),
  ).toBeNull();
  expect(
    container.querySelector('[aria-label="Close bottom sheet"]'),
  ).toBeDisabled();
});

it.each(['Recent Sessions', 'Recent PRs'])(
  'returns focus to %s when closing its sheet',
  (name) => {
    render(<BottomSheetTabs />);
    const tab = screen.getByRole('button', { name });
    fireEvent.click(tab);
    const close = screen.getByRole('button', { name: 'Close bottom sheet' });
    expect(close).toBeEnabled();
    close.focus();
    fireEvent.click(close);

    expect(tab).toHaveFocus();
    expect(close).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Close bottom sheet' }),
    ).toBeNull();
  },
);

it('returns focus to the current tab after switching the open sheet', () => {
  render(<BottomSheetTabs />);
  fireEvent.click(screen.getByRole('button', { name: 'Recent Sessions' }));
  const pullRequests = screen.getByRole('button', { name: 'Recent PRs' });
  fireEvent.click(pullRequests);
  fireEvent.click(screen.getByRole('button', { name: 'Close bottom sheet' }));

  expect(pullRequests).toHaveFocus();
});

it('hides retained panel controls from assistive navigation as soon as closing starts', () => {
  render(<BottomSheetTabs />);
  fireEvent.click(screen.getByRole('button', { name: 'Recent Sessions' }));
  expect(
    screen.getByRole('button', { name: 'Recent session action' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close bottom sheet' }));

  expect(
    screen.queryByRole('button', { name: 'Recent session action' }),
  ).toBeNull();
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
