import { runFactory, taskFactory, userFactory } from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { TaskBoardColumn } from '@/types';

import { getTasks } from './tasks';

describe('getTasks board columns', () => {
  async function createRun(taskId: string, taskPhase: string | null = null) {
    await runFactory.create({
      taskId,
      taskPhase,
      payloadKind: TaskPayloadKind.StandardTask,
    });
  }

  it('filters columns before pagination using the latest run phase and board precedence', async () => {
    const user = await userFactory.create({});
    const needsInput = await taskFactory.create({
      initiatorUserId: user.id,
      state: 'active',
      goalStatus: 'blocked',
      activityAt: 4_000,
    });
    await createRun(needsInput.id, 'waiting_for_user_input');

    const blocked = await taskFactory.create({
      initiatorUserId: user.id,
      state: 'completed',
      goalStatus: 'blocked',
      activityAt: 3_000,
    });
    await createRun(blocked.id);

    const done = await taskFactory.create({
      initiatorUserId: user.id,
      state: 'active',
      goalStatus: 'complete',
      activityAt: 2_000,
    });
    await createRun(done.id);

    const active = await taskFactory.create({
      initiatorUserId: user.id,
      state: 'active',
      goalStatus: null,
      activityAt: 1_000,
    });
    await createRun(active.id, 'waiting_for_user_input');
    await createRun(active.id);

    const expectedIds: Record<TaskBoardColumn, string> = {
      active: active.id,
      'needs-input': needsInput.id,
      blocked: blocked.id,
      done: done.id,
    };

    for (const boardColumn of Object.keys(expectedIds) as TaskBoardColumn[]) {
      const result = await getTasks({
        userId: user.id,
        filters: [{ type: 'userId', value: user.id, label: user.id }],
        boardColumn,
      });

      expect(result.tasks.map((task) => task.id)).toEqual([
        expectedIds[boardColumn],
      ]);
    }
  });

  it('keeps an independent cursor within one board column', async () => {
    const user = await userFactory.create({});
    const activeTasks = await Promise.all(
      [3_000, 2_000, 1_000].map(async (activityAt) => {
        const task = await taskFactory.create({
          initiatorUserId: user.id,
          state: 'active',
          goalStatus: null,
          activityAt,
        });
        await createRun(task.id);
        return task;
      }),
    );
    const blocked = await taskFactory.create({
      initiatorUserId: user.id,
      state: 'failed',
      activityAt: 4_000,
    });
    await createRun(blocked.id);

    const firstPage = await getTasks({
      userId: user.id,
      filters: [{ type: 'userId', value: user.id, label: user.id }],
      boardColumn: 'active',
      limit: 2,
    });
    const secondPage = await getTasks({
      userId: user.id,
      filters: [{ type: 'userId', value: user.id, label: user.id }],
      boardColumn: 'active',
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.tasks.map((task) => task.id)).toEqual([
      activeTasks[0]!.id,
      activeTasks[1]!.id,
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.tasks.map((task) => task.id)).toEqual([
      activeTasks[2]!.id,
    ]);
    expect(secondPage.hasMore).toBe(false);
  });
});
