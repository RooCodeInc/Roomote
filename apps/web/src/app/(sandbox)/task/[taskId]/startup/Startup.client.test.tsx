import { fireEvent, render, screen } from '@testing-library/react';

import { RunStatus } from '@roomote/types';

const { replaceFailedStartMutate, routerPush } = vi.hoisted(() => ({
  replaceFailedStartMutate: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('react-hooks-sse', () => ({
  SSEProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/hooks/task-runs', () => ({
  useReplaceFailedTaskStart: (options: {
    onSuccess: (result: { taskId: string; runId: number }) => void;
  }) => ({
    isPending: false,
    mutate: (input: { runId: number }) => {
      replaceFailedStartMutate(input);
      options.onSuccess({ taskId: 'replacement-task', runId: 88 });
    },
  }),
}));

vi.mock('./useStartupProgress', () => ({
  useStartupProgress: () => ({
    steps: [{ status: RunStatus.Failed, completed: true }],
    error: 'Provider failed to start',
    errorCode: null,
    showLogs: false,
    sandboxLogs: [],
    logsConnected: false,
    logsError: null,
  }),
}));

vi.mock('./StartupMessage', () => ({
  StartupSequence: ({
    prompt,
    onRetry,
  }: {
    prompt?: string;
    onRetry?: () => void;
  }) => (
    <div>
      <span>{prompt}</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
  StartupFailureMessage: () => null,
}));

import { Startup } from './Startup';

describe('Startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a replacement and navigates directly to it', () => {
    render(<Startup runId={77} prompt="Original prompt" />);

    expect(screen.getByText('Original prompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(replaceFailedStartMutate).toHaveBeenCalledWith({ runId: 77 });
    expect(routerPush).toHaveBeenCalledWith('/task/replacement-task');
  });
});
