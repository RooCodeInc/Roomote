import {
  and,
  count,
  db,
  desc,
  eq,
  isNull,
  taskPins,
  tasks,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

const MAX_PINNED_TASKS = 5;

export async function listPinnedTaskIdsCommand(auth: UserAuthSuccess) {
  return db
    .select({
      taskId: taskPins.taskId,
      updatedAt: taskPins.updatedAt,
    })
    .from(taskPins)
    .where(eq(taskPins.userId, auth.userId))
    .orderBy(desc(taskPins.updatedAt));
}

type SetTaskPinnedResult =
  | { success: true; pinned: boolean }
  | { success: false; error: 'task_not_found' | 'pin_limit_reached' };

export async function setTaskPinnedCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; pinned: boolean },
): Promise<SetTaskPinnedResult> {
  if (!input.pinned) {
    await db
      .delete(taskPins)
      .where(
        and(
          eq(taskPins.taskId, input.taskId),
          eq(taskPins.userId, auth.userId),
        ),
      );

    return { success: true, pinned: false };
  }

  // Any deployment member can pin any task; pins stay per-user via task_pins.
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), isNull(tasks.deletedAt)))
    .limit(1);

  if (!task) {
    return { success: false, error: 'task_not_found' };
  }

  const [existingPin] = await db
    .select({ id: taskPins.id })
    .from(taskPins)
    .where(
      and(eq(taskPins.taskId, input.taskId), eq(taskPins.userId, auth.userId)),
    )
    .limit(1);

  if (existingPin) {
    return { success: true, pinned: true };
  }

  const [pinCountResult] = await db
    .select({ value: count() })
    .from(taskPins)
    .where(eq(taskPins.userId, auth.userId))
    .limit(1);

  if ((pinCountResult?.value ?? 0) >= MAX_PINNED_TASKS) {
    return { success: false, error: 'pin_limit_reached' };
  }

  await db.insert(taskPins).values({
    taskId: input.taskId,
    userId: auth.userId,
  });

  return { success: true, pinned: true };
}
