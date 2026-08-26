import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RunStatus } from '@roomote/types';

import type { Task } from '@/lib/server';

const { acknowledgeMock, acknowledgeState, errorToastMock } = vi.hoisted(
  () => ({
    acknowledgeMock: vi.fn(),
    acknowledgeState: { isPending: false },
    errorToastMock: vi.fn(),
  }),
);

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: errorToastMock },
}));

vi.mock('@/hooks/tasks', () => ({
  isTaskResolutionActionable: (status?: string | null) =>
    status === 'awaiting_confirmation' || status === 'needs_follow_up',
  useAcknowledgeTaskResolution: () => ({
    mutateAsync: acknowledgeMock,
    isPending: acknowledgeState.isPending,
  }),
}));

vi.mock('@/components/sandbox', () => ({
  WorkspaceBadge: ({ repo }: { repo?: string }) => <span>{repo}</span>,
  PullRequestBadge: ({
    prNumber,
    className,
  }: {
    prNumber: number;
    className?: string;
  }) => (
    <a href={`https://example.test/pull/${prNumber}`} className={className}>
      PR #{prNumber}
    </a>
  ),
}));

vi.mock('./TaskAutomationIcon', () => ({
  TaskAutomationIcon: () => <svg data-testid="automation-icon" />,
}));

import { TaskBoard } from './TaskBoard';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    initiatorKind: 'user',
    initiatorUserId: 'user-1',
    initiatorAutomation: null,
    title: 'Active task',
    mode: null,
    state: 'active',
    requestedWorkKind: 'unknown',
    resolutionStatus: null,
    workflow: 'standard',
    surface: 'discord',
    timestamp: new Date('2026-08-20T12:00:00Z').getTime() / 1000,
    repositoryName: 'RooCodeInc/Roomote',
    attributionLabel: 'Ada',
    attributionKind: 'user',
    user: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@roomote.test',
      imageUrl: '',
    },
    participants: [
      {
        id: 'user-2',
        name: 'Grace',
        email: 'grace@roomote.test',
        imageUrl: '',
      },
    ],
    taskRun: {
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: { repo: 'RooCodeInc/Roomote' },
      prRepo: null,
      prNumber: null,
    },
    ...overrides,
  } as Task;
}

describe('TaskBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acknowledgeState.isPending = false;
    acknowledgeMock.mockResolvedValue({ success: true, changed: true });
  });

  it('keeps pull request badges independently clickable', () => {
    render(
      <TaskBoard
        tasks={[
          createTask({
            taskRun: {
              status: RunStatus.Running,
              taskPhase: 'running',
              payload: {},
              prRepo: 'RooCodeInc/Roomote',
              prNumber: 42,
            } as Task['taskRun'],
          }),
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: 'PR #42' })).toHaveAttribute(
      'href',
      'https://example.test/pull/42',
    );
  });

  it('groups tasks and keeps completed work bounded', () => {
    const doneTasks = Array.from({ length: 8 }, (_, index) =>
      createTask({
        id: `done-${index}`,
        title: `Completed task ${index + 1}`,
        state: 'completed',
        taskRun: {
          status: RunStatus.Completed,
          taskPhase: null,
          payload: {},
          prRepo: null,
          prNumber: null,
        } as Task['taskRun'],
      }),
    );

    render(
      <TaskBoard
        tasks={[
          createTask(),
          createTask({
            id: 'needs-input',
            title: 'Answer deployment question',
            taskRun: {
              status: RunStatus.Running,
              taskPhase: 'waiting_for_user_input',
              payload: {},
              prRepo: null,
              prNumber: null,
            } as Task['taskRun'],
          }),
          createTask({
            id: 'blocked',
            title: 'Fix failed release',
            state: 'failed',
          }),
          ...doneTasks,
        ]}
      />,
    );

    expect(
      screen.getByRole('heading', { name: /^Active/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /^Needs input/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /^Blocked \/ failed/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Done/ })).toBeInTheDocument();
    expect(screen.getByText('Active task')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open task: Active task' }),
    ).toHaveAttribute('href', '/task/task-1');
    expect(screen.queryByText('Code')).not.toBeInTheDocument();
    expect(screen.queryByText('Discord')).not.toBeInTheDocument();
    expect(
      screen.getByText('2 older completed tasks hidden'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Completed task 7')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
  });

  it('marks actionable task resolutions done from the card', async () => {
    render(
      <TaskBoard
        tasks={[
          createTask({
            resolutionStatus: 'awaiting_confirmation',
            taskRun: {
              status: RunStatus.Idle,
              taskPhase: 'waiting_for_prompt',
              payload: {},
              prRepo: null,
              prNumber: null,
            } as Task['taskRun'],
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));

    await waitFor(() => {
      expect(acknowledgeMock).toHaveBeenCalledWith({ taskId: 'task-1' });
    });
  });

  it('disables an actionable card while acknowledgement is pending', () => {
    acknowledgeState.isPending = true;

    render(
      <TaskBoard
        tasks={[
          createTask({ resolutionStatus: 'awaiting_confirmation' }),
          createTask({
            id: 'pending-task',
            resolutionStatus: 'awaiting_confirmation',
            taskRun: {
              status: RunStatus.Idle,
              taskPhase: 'waiting_for_prompt',
              payload: {},
              prRepo: null,
              prNumber: null,
            } as Task['taskRun'],
          }),
        ]}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Marking task done' }),
    ).toBeDisabled();
  });

  it('reports acknowledgement errors from the card', async () => {
    acknowledgeMock.mockRejectedValueOnce(new Error('Could not update task'));

    render(
      <TaskBoard
        tasks={[
          createTask({
            resolutionStatus: 'needs_follow_up',
            taskRun: {
              status: RunStatus.Idle,
              taskPhase: 'waiting_for_prompt',
              payload: {},
              prRepo: null,
              prNumber: null,
            } as Task['taskRun'],
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));

    await waitFor(() => {
      expect(errorToastMock).toHaveBeenCalledWith('Could not update task');
    });
  });
});
