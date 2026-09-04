import {
  TASK_ROBOT_ICON_COUNT,
  resolveTaskRobotIconId,
} from './task-robot-icons';

const taskIds = Array.from({ length: 101 }, (_, index) => `task-${index + 1}`);

describe('task robot icon assignment', () => {
  it('is deterministic for the same task and session', () => {
    const input = {
      taskId: 'task-42',
      sessionId: 'session-a',
      orderedTaskIds: taskIds,
    };

    expect(resolveTaskRobotIconId(input)).toBe(resolveTaskRobotIconId(input));
  });

  it('keeps all first 100 tasks in a session unique', () => {
    const assignments = taskIds.slice(0, TASK_ROBOT_ICON_COUNT).map((taskId) =>
      resolveTaskRobotIconId({
        taskId,
        sessionId: 'session-a',
        orderedTaskIds: taskIds,
      }),
    );

    expect(new Set(assignments).size).toBe(TASK_ROBOT_ICON_COUNT);
  });

  it('uses a different seeded order for another session', () => {
    const assignments = (sessionId: string) =>
      taskIds.slice(0, 10).map((taskId) =>
        resolveTaskRobotIconId({
          taskId,
          sessionId,
          orderedTaskIds: taskIds,
        }),
      );

    expect(assignments('session-a')).not.toEqual(assignments('session-b'));
  });

  it('preserves existing assignments as an ordered task list grows', () => {
    const initialTaskIds = taskIds.slice(0, 3);
    const expandedTaskIds = taskIds.slice(0, 8);

    expect(
      initialTaskIds.map((taskId) =>
        resolveTaskRobotIconId({
          taskId,
          sessionId: 'session-a',
          orderedTaskIds: initialTaskIds,
        }),
      ),
    ).toEqual(
      initialTaskIds.map((taskId) =>
        resolveTaskRobotIconId({
          taskId,
          sessionId: 'session-a',
          orderedTaskIds: expandedTaskIds,
        }),
      ),
    );
  });

  it('reuses the seeded permutation after 100 tasks', () => {
    const first = resolveTaskRobotIconId({
      taskId: taskIds[0]!,
      sessionId: 'session-a',
      orderedTaskIds: taskIds,
    });
    const oneHundredAndFirst = resolveTaskRobotIconId({
      taskId: taskIds[100]!,
      sessionId: 'session-a',
      orderedTaskIds: taskIds,
    });

    expect(oneHundredAndFirst).toBe(first);
  });

  it('provides a stable hash fallback when the task list is partial', () => {
    const input = { taskId: 'unknown-task', sessionId: 'session-a' };

    expect(resolveTaskRobotIconId(input)).toBe(resolveTaskRobotIconId(input));
    expect(resolveTaskRobotIconId(input)).toMatch(/^robot-\d{3}$/);
  });
});
