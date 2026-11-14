import { db, eq, taskFactory, taskPins, userFactory } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { deleteTasksCommand } from '../delete';
import { listPinnedTaskIdsCommand, setTaskPinnedCommand } from '../pins';

describe('task pin lifecycle', () => {
  it('frees a pin slot after actual soft deletion while keeping the five-live-task limit', async () => {
    const owner = await userFactory.create();
    const auth = { userId: owner.id, isAdmin: false } as UserAuthSuccess;
    const targets = await Promise.all(
      Array.from({ length: 7 }, () =>
        taskFactory.create({ initiatorUserId: owner.id }),
      ),
    );
    for (const task of targets.slice(0, 5)) {
      expect(
        await setTaskPinnedCommand(auth, { taskId: task.id, pinned: true }),
      ).toEqual({ success: true, pinned: true });
    }

    expect(
      await deleteTasksCommand(auth, { taskIds: [targets[0]!.id] }),
    ).toMatchObject({ deletedCount: 1 });
    // The task and its pin are retained; a physical FK cascade is not involved.
    expect(
      await db.select().from(taskPins).where(eq(taskPins.userId, owner.id)),
    ).toHaveLength(5);
    const remaining = await listPinnedTaskIdsCommand(auth);
    expect(remaining).toHaveLength(4);
    expect(remaining.map((pin) => pin.taskId)).not.toContain(targets[0]!.id);
    expect(
      await setTaskPinnedCommand(auth, {
        taskId: targets[5]!.id,
        pinned: true,
      }),
    ).toEqual({ success: true, pinned: true });
    expect(await listPinnedTaskIdsCommand(auth)).toHaveLength(5);
    expect(
      await setTaskPinnedCommand(auth, {
        taskId: targets[6]!.id,
        pinned: true,
      }),
    ).toEqual({ success: false, error: 'pin_limit_reached' });
    // Repeating an existing pin is still idempotent, even at the limit.
    expect(
      await setTaskPinnedCommand(auth, {
        taskId: targets[5]!.id,
        pinned: true,
      }),
    ).toEqual({ success: true, pinned: true });
  });

  it('recovers already-stale pins and keeps pins per-user on collaborative tasks', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const auth = { userId: owner.id, isAdmin: false } as UserAuthSuccess;
    const otherAuth = { userId: other.id, isAdmin: false } as UserAuthSuccess;
    const stale = await taskFactory.create({
      initiatorUserId: owner.id,
      deletedAt: new Date(),
    });
    const live = await taskFactory.create({ initiatorUserId: other.id });
    // A preexisting soft-deleted target, including session deletion, needs no migration.
    await db.insert(taskPins).values({ userId: owner.id, taskId: stale.id });
    expect(await listPinnedTaskIdsCommand(auth)).toEqual([]);
    expect(
      await setTaskPinnedCommand(auth, { taskId: live.id, pinned: true }),
    ).toEqual({ success: true, pinned: true });
    expect(await listPinnedTaskIdsCommand(otherAuth)).toEqual([]);
    expect(
      await setTaskPinnedCommand(otherAuth, { taskId: live.id, pinned: true }),
    ).toEqual({ success: true, pinned: true });
    await setTaskPinnedCommand(auth, { taskId: live.id, pinned: false });
    expect(await listPinnedTaskIdsCommand(auth)).toEqual([]);
    expect(
      (await listPinnedTaskIdsCommand(otherAuth)).map((pin) => pin.taskId),
    ).toEqual([live.id]);
  });

  it('rejects deleted targets and still permits idempotent stale-pin removal', async () => {
    const owner = await userFactory.create();
    const auth = { userId: owner.id, isAdmin: false } as UserAuthSuccess;
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      deletedAt: new Date(),
    });
    await db.insert(taskPins).values({ userId: owner.id, taskId: task.id });
    expect(
      await setTaskPinnedCommand(auth, { taskId: task.id, pinned: true }),
    ).toEqual({ success: false, error: 'task_not_found' });
    for (let i = 0; i < 2; i++) {
      expect(
        await setTaskPinnedCommand(auth, { taskId: task.id, pinned: false }),
      ).toEqual({ success: true, pinned: false });
    }
    expect(
      await db.select().from(taskPins).where(eq(taskPins.userId, owner.id)),
    ).toEqual([]);
  });
});
