import { fireEvent, render, screen } from '@testing-library/react';
import { RunStatus } from '@roomote/types';

const useQueryMock = vi.fn();
const queryOptionsMock = vi.fn((input, options) => ({ input, ...options }));
const mutateMock = vi.fn();
const refetchMock = vi.fn();
const useCancelTaskRunMock = vi.fn();

vi.mock('@/hooks/task-runs/useCancelTaskRun', () => ({
  useCancelTaskRun: (options: unknown) => useCancelTaskRunMock(options),
}));

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
    useCancelTaskRunMock.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    });
    useQueryMock.mockReturnValue({
      isPending: false,
      refetch: refetchMock,
      data: {
        task: { title: 'Fix checkout' },
        taskRun: {
          id: 42,
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
    expect(screen.getByText('Coding agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Working')).toBeInTheDocument();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-task-robot-icon]'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'View coding task: Fix checkout' }),
    );
    expect(onOpen).toHaveBeenCalledWith('child-1');

    const queryOptions = queryOptionsMock.mock.calls[0]![1];
    // Server-provided interval wins; otherwise poll until the run exits.
    expect(
      queryOptions.refetchInterval({
        state: { data: { refetchInterval: 1_500 } },
      }),
    ).toBe(1_500);
    expect(queryOptions.refetchInterval({ state: { data: undefined } })).toBe(
      2_000,
    );
    expect(
      queryOptions.refetchInterval({
        state: { data: { taskRun: { status: 'running' } } },
      }),
    ).toBe(2_000);
    expect(
      queryOptions.refetchInterval({
        state: { data: { taskRun: { status: 'completed' } } },
      }),
    ).toBe(false);
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
    expect(screen.getByLabelText('Working')).toBeInTheDocument();

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

    expect(screen.getByLabelText('Error')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Stop coding task' }),
    ).not.toBeInTheDocument();
  });

  it('stops the exact run immediately without opening or bubbling', () => {
    const onOpen = vi.fn();
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={onOpen} />
      </div>,
    );
    const stop = screen.getByRole('button', { name: 'Stop coding task' });
    expect(stop.parentElement?.closest('button')).toBeNull();
    fireEvent.click(stop);
    expect(mutateMock).toHaveBeenCalledWith({ taskId: 'child-1', runId: 42 });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not show a canceled run as working when its phase is stale', () => {
    useQueryMock.mockReturnValue({
      data: {
        taskRun: { id: 42, status: RunStatus.Canceled, taskPhase: 'running' },
      },
    });
    render(
      <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={vi.fn()} />,
    );
    expect(screen.queryByLabelText('Working')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Terminating')).toBeInTheDocument();
  });

  it('disables stop while cancellation is pending but preserves opening', () => {
    useCancelTaskRunMock.mockReturnValue({
      mutate: mutateMock,
      isPending: true,
    });
    const onOpen = vi.fn();
    render(
      <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={onOpen} />,
    );
    const stop = screen.getByRole('button', { name: 'Stop coding task' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(stop);
    expect(mutateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Fix checkout'));
    expect(onOpen).toHaveBeenCalledWith('child-1');
  });

  it('refreshes the card after successful cancellation', () => {
    useCancelTaskRunMock.mockImplementation(({ onSuccess }) => ({
      mutate: () => onSuccess({ success: true }),
      isPending: false,
    }));
    render(
      <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop coding task' }));
    expect(refetchMock).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['result', 'exception'])(
    'announces cancellation %s errors without opening',
    (kind) => {
      useCancelTaskRunMock.mockImplementation(({ onSuccess, onError }) => ({
        mutate: () =>
          kind === 'result'
            ? onSuccess({ success: false, error: 'Cannot stop task' })
            : onError(new Error('Cannot stop task')),
        isPending: false,
      }));
      const onOpen = vi.fn();
      render(
        <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={onOpen} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Stop coding task' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Cannot stop task');
      expect(refetchMock).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it.each([RunStatus.Pending, RunStatus.Running, RunStatus.Idle])(
    'allows stopping active %s runs',
    (status) => {
      useQueryMock.mockReturnValue({ data: { taskRun: { id: 42, status } } });
      render(
        <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={vi.fn()} />,
      );
      expect(
        screen.getByRole('button', { name: 'Stop coding task' }),
      ).toBeEnabled();
    },
  );

  it.each([RunStatus.Completed, RunStatus.Failed, RunStatus.Canceled, null])(
    'hides stop for terminal or inaccessible runs: %s',
    (status) => {
      useQueryMock.mockReturnValue({
        data: { taskRun: status ? { id: 42, status } : null },
      });
      render(
        <DelegatedTaskCard taskId="child-1" prompt={null} onOpen={vi.fn()} />,
      );
      expect(
        screen.queryByRole('button', { name: 'Stop coding task' }),
      ).not.toBeInTheDocument();
    },
  );
});
