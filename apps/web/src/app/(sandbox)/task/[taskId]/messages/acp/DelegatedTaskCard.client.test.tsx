import { fireEvent, render, screen } from '@testing-library/react';
import { RunStatus } from '@roomote/types';

const useQueryMock = vi.fn();
const queryOptionsMock = vi.fn((input, options) => ({ input, ...options }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sandboxSession: { byTaskId: { queryOptions: queryOptionsMock } },
  }),
}));

import { DelegatedTaskCard } from './DelegatedTaskCard';

describe('DelegatedTaskCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueryMock.mockReturnValue({
      isPending: false,
      data: {
        task: { title: 'Fix checkout' },
        taskRun: {
          status: RunStatus.Running,
          taskPhase: 'running',
          error: null,
        },
      },
    });
  });

  it('renders live task state and opens the selected child', () => {
    const onOpen = vi.fn();
    render(
      <DelegatedTaskCard
        taskId="child-1"
        prompt="Fallback prompt"
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText('Fix checkout')).toBeInTheDocument();
    expect(screen.getByText('Started coding task')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'View coding task: Fix checkout' }),
    );
    expect(onOpen).toHaveBeenCalledWith('child-1');

    const queryOptions = queryOptionsMock.mock.calls[0]![1];
    expect(queryOptions.refetchInterval({ state: { data: undefined } })).toBe(
      2_000,
    );
    expect(queryOptionsMock).toHaveBeenCalledWith(
      { taskId: 'child-1' },
      expect.any(Object),
    );
  });

  it('updates when the child transitions to a terminal state', () => {
    let queryResult = {
      isPending: false,
      data: {
        task: { title: 'Fix checkout' },
        taskRun: {
          status: RunStatus.Running,
          taskPhase: 'running',
          error: null as string | null,
        },
      },
    };
    useQueryMock.mockImplementation(() => queryResult);

    const { rerender } = render(
      <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={vi.fn()} />,
    );
    expect(screen.getByText('Working')).toBeInTheDocument();

    queryResult = {
      ...queryResult,
      data: {
        ...queryResult.data,
        taskRun: {
          status: RunStatus.Failed,
          taskPhase: 'shutting_down',
          error: 'Task failed',
        },
      },
    };
    rerender(
      <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={vi.fn()} />,
    );

    expect(screen.getByText('Error')).toBeInTheDocument();
  });
});
