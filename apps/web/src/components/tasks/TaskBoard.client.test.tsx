import { render, screen } from '@testing-library/react';

import { RunStatus } from '@roomote/types';

import type { Task } from '@/lib/server';

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
  });

  it('uses the automation icon instead of the initiating user avatar', () => {
    render(
      <TaskBoard
        tasks={[
          createTask({
            attributionKind: 'automation',
            initiatorAutomation: 'review_code',
            participants: [],
          }),
        ]}
      />,
    );

    expect(screen.getByTestId('automation-icon')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Ada' })).not.toBeInTheDocument();
  });
});
