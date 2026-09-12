import { fireEvent, render, screen, waitFor } from '@testing-library/react';

type InfiniteTasksState = {
  data?: { pages: { tasks: { id: string }[]; nextCursor?: string }[] };
  isPending: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
  deleteMutate: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  state: {} as InfiniteTasksState,
}));

const loadedPage = {
  pages: [{ tasks: [{ id: 'task-1' }, { id: 'task-2' }] }],
};

function setState(next: Partial<InfiniteTasksState>) {
  Object.assign(mocks.state, next);
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ userId: 'user-1', isAdmin: false }),
}));

vi.mock('@/hooks/tasks', () => ({
  useInfiniteTasks: () => ({
    ...mocks.state,
    refetch: mocks.refetch,
    fetchNextPage: mocks.fetchNextPage,
  }),
  useDeleteTasks: () => ({ mutate: mocks.deleteMutate, isPending: false }),
  useTaskFilterState: () => ({
    hasSpecificUserFilter: false,
    hasNonDefaultFilters: false,
  }),
}));

vi.mock('@/components/tasks', async () => {
  const { TaskCardError } = await import('@/components/tasks/TaskCardError');

  return {
    TaskCardError,
    TaskFilters: () => <div data-testid="task-filters" />,
    TaskCard: ({ task }: { task: { id: string } }) => (
      <div data-testid="task-card">{task.id}</div>
    ),
    TaskBoard: ({ tasks }: { tasks: { id: string }[] }) => (
      <div data-testid="task-board">{tasks.length}</div>
    ),
    TaskCardSkeleton: () => <div data-testid="task-card-skeleton" />,
    TaskBoardSkeleton: () => <div data-testid="task-board-skeleton" />,
  };
});

import { Tasks } from './Tasks';

describe('Tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    setState({
      data: undefined,
      isPending: true,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
    });
  });

  it('shows the loading skeleton while the initial query is pending', () => {
    render(<Tasks />);

    expect(screen.getByTestId('task-card-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load tasks.')).not.toBeInTheDocument();
  });

  it('shows the retry action once the initial load has failed', async () => {
    setState({ isPending: false, isError: true, data: undefined });

    render(<Tasks />);

    expect(
      await screen.findByText('Failed to load tasks.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryAllByTestId('task-card')).toHaveLength(0);
  });

  it('refetches the tasks query and restores the list when the user retries', async () => {
    setState({ isPending: false, isError: true, data: undefined });

    const { rerender } = render(<Tasks />);
    const retry = await screen.findByRole('button', { name: 'Retry' });

    // A successful refetch flips the query into its loaded state, exactly as
    // React Query would after the request succeeds.
    mocks.refetch.mockImplementation(() => {
      setState({ isError: false, data: loadedPage });
      return Promise.resolve();
    });

    fireEvent.click(retry);

    expect(mocks.refetch).toHaveBeenCalledOnce();

    rerender(<Tasks />);

    await waitFor(() =>
      expect(screen.getAllByTestId('task-card')).toHaveLength(2),
    );
    expect(screen.queryByText('Failed to load tasks.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps already loaded tasks visible when a later refresh fails', async () => {
    setState({ isPending: false, isError: true, data: loadedPage });

    render(<Tasks />);

    await waitFor(() =>
      expect(screen.getAllByTestId('task-card')).toHaveLength(2),
    );
    expect(screen.queryByText('Failed to load tasks.')).not.toBeInTheDocument();
  });
});
