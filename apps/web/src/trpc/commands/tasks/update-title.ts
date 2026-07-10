import { db, tasks, eq, and, isNull } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

export async function updateTaskTitleCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; title: string },
) {
  void auth;
  const title = input.title.trim();

  if (!title) {
    throw new Error('Task title cannot be empty');
  }

  // Any deployment member can rename a task.
  const whereConditions = [eq(tasks.id, input.taskId), isNull(tasks.deletedAt)];

  const [updatedTask] = await db
    .update(tasks)
    .set({
      title,
      titleEditedByUserAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(...whereConditions))
    .returning({
      id: tasks.id,
      title: tasks.title,
    });

  if (!updatedTask) {
    throw new Error(
      'Task not found or you do not have permission to rename it',
    );
  }

  return { success: true as const, task: updatedTask };
}
