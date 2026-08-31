import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { RunStatus } from '@roomote/types';

import type { Task } from '@/lib/server';
import type { TaskBoardColumn } from '@/types';

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

type TaskBoardColumns = ComponentProps<typeof TaskBoard>['columns'];
type TaskBoardColumnData = TaskBoardColumns[TaskBoardColumn];

function createColumns(
  overrides: Partial<
    Record<TaskBoardColumn, Partial<TaskBoardColumnData>>
  > = {},
): TaskBoardColumns {
  const createColumn = (column: TaskBoardColumn): TaskBoardColumnData => ({
    tasks: [],
    hasNextPage: false,
    isFetchingNextPage: false,
    onShowMore: vi.fn(),
    ...overrides[column],
  });

  return {
    active: createColumn('active'),
    'needs-input': createColumn('needs-input'),
    blocked: createColumn('blocked'),
    done: createColumn('done'),
  };
}

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
        columns={createColumns({
          active: {
            tasks: [
              createTask({
                taskRun: {
                  status: RunStatus.Running,
                  taskPhase: 'running',
                  payload: {},
                  prRepo: 'RooCodeInc/Roomote',
                  prNumber: 42,
                } as Task['taskRun'],
              }),
            ],
          },
        })}
      />,
    );

    expect(screen.getByRole('link', { name: 'PR #42' })).toHaveAttribute(
      'href',
      'https://example.test/pull/42',
    );
  });

  it('renders tasks in their server-assigned columns', () => {
    render(
      <TaskBoard
        columns={createColumns({
          active: { tasks: [createTask()] },
          'needs-input': {
            tasks: [
              createTask({
                id: 'needs-input',
                title: 'Answer deployment question',
              }),
            ],
          },
          blocked: {
            tasks: [
              createTask({
                id: 'blocked',
                title: 'Fix failed release',
                state: 'failed',
                goalBlockedReason: 'Release checks failed',
              }),
            ],
          },
          done: {
            tasks: [
              createTask({
                id: 'done',
                title: 'Completed task',
                state: 'completed',
              }),
            ],
          },
        })}
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
    expect(screen.getByText('Release checks failed')).toBeInTheDocument();
    expect(screen.getByText('Completed task')).toBeInTheDocument();
  });

  it('loads only the selected column', () => {
    const showMoreActive = vi.fn();
    const showMoreDone = vi.fn();

    render(
      <TaskBoard
        columns={createColumns({
          active: {
            tasks: [createTask()],
            hasNextPage: true,
            onShowMore: showMoreActive,
          },
          done: {
            hasNextPage: true,
            onShowMore: showMoreDone,
          },
        })}
      />,
    );

    expect(screen.getAllByRole('button', { name: /^Show more/ })).toHaveLength(
      2,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Show more done tasks' }),
    );
    expect(showMoreDone).toHaveBeenCalledOnce();
    expect(showMoreActive).not.toHaveBeenCalled();
  });
});
