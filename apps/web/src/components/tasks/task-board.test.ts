import { RunStatus } from '@roomote/types';

import type { Task } from '@/lib/server';

import { getTaskBoardColumn, getTaskWorkType } from './task-board';

type TaskOverrides = Omit<Partial<Task>, 'taskRun'> & {
  taskRun?: Partial<Task['taskRun']>;
};

function createTask(overrides: TaskOverrides = {}): Task {
  const { taskRun: taskRunOverrides, ...taskOverrides } = overrides;

  return {
    id: 'task-1',
    initiatorKind: 'user',
    initiatorUserId: 'user-1',
    initiatorAutomation: null,
    title: 'Task',
    mode: null,
    state: 'active',
    timestamp: 1,
    attributionLabel: 'Ada',
    attributionKind: 'user',
    user: null,
    participants: [],
    taskRun: {
      id: 1,
      payloadKind: 'standard',
      payload: {} as Task['taskRun']['payload'],
      status: RunStatus.Running,
      taskPhase: 'running',
      firstAssistantOutputAt: null,
      prRepo: null,
      prNumber: null,
      ...taskRunOverrides,
    } as Task['taskRun'],
    ...taskOverrides,
  } as Task;
}

describe('task board', () => {
  it('puts waiting tasks ahead of their broader active state', () => {
    expect(
      getTaskBoardColumn(
        createTask({ taskRun: { taskPhase: 'waiting_for_user_input' } }),
      ),
    ).toBe('needs-input');
  });

  it('groups goal blockers and failures together', () => {
    expect(getTaskBoardColumn(createTask({ goalStatus: 'blocked' }))).toBe(
      'blocked',
    );
    expect(getTaskBoardColumn(createTask({ state: 'failed' }))).toBe('blocked');
  });

  it('groups completed and canceled tasks as done', () => {
    expect(getTaskBoardColumn(createTask({ state: 'completed' }))).toBe('done');
    expect(getTaskBoardColumn(createTask({ state: 'canceled' }))).toBe('done');
  });

  it('keeps durable active tasks active when the latest run is terminal', () => {
    expect(
      getTaskBoardColumn(
        createTask({
          taskRun: { status: RunStatus.Completed, taskPhase: null },
        }),
      ),
    ).toBe('active');
  });

  it('distinguishes code, review, automation, and conversation work', () => {
    expect(
      getTaskWorkType(
        createTask({
          taskRun: {
            payload: { repo: 'org/repo' } as Task['taskRun']['payload'],
          },
        }),
      ),
    ).toBe('Code');
    expect(getTaskWorkType(createTask({ workflow: 'pr_review' }))).toBe(
      'Review',
    );
    expect(getTaskWorkType(createTask({ initiatorKind: 'automation' }))).toBe(
      'Automation',
    );
    expect(getTaskWorkType(createTask())).toBe('Conversation');
  });
});
