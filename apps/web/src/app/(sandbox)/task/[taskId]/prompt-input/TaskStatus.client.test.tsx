import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { TaskStatus } from './TaskStatus';

const useSandboxTaskStatusDisplayMock = vi.fn();

vi.mock('@/components/system', () => ({
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/sandbox', () => ({
  TaskStatusIndicator: ({ phase }: { phase?: string | null }) => (
    <div>{phase}</div>
  ),
}));

vi.mock('../hooks/SandboxProvider', () => ({
  useSandboxTaskStatusDisplay: () => useSandboxTaskStatusDisplayMock(),
}));

describe('TaskStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T07:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows the sleep badge while waiting for a follow-up prompt', () => {
    useSandboxTaskStatusDisplayMock.mockReturnValue({
      phase: 'waiting_for_prompt',
      lastErrorMessage: null,
    });

    render(
      <TaskStatus
        taskRun={
          {
            sleepAt: '2026-03-20T07:02:00Z',
            taskPhase: 'waiting_for_prompt',
          } as never
        }
      />,
    );

    expect(screen.getByText('2m')).toBeInTheDocument();
  });

  it('keeps the sleep badge hidden while the task is actively running', () => {
    useSandboxTaskStatusDisplayMock.mockReturnValue({
      phase: 'running',
      lastErrorMessage: null,
    });

    render(
      <TaskStatus
        taskRun={
          {
            sleepAt: '2026-03-20T07:02:00Z',
            taskPhase: 'waiting_for_prompt',
          } as never
        }
      />,
    );

    expect(screen.queryByText('2m')).not.toBeInTheDocument();
  });
});
