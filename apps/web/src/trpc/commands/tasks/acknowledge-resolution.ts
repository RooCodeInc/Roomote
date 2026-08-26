import { acknowledgeTaskResolution, db, eq, isNull } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

export async function acknowledgeTaskResolutionCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
) {
  void auth;

  // Task management is deployment-wide: any member can acknowledge any task.
  const task = await db.query.tasks.findFirst({
    where: (task, { and }) =>
      and(eq(task.id, input.taskId), isNull(task.deletedAt)),
    columns: { id: true },
  });

  if (!task) {
    throw new Error(
      'Task not found or you do not have permission to update it',
    );
  }

  const changed = await acknowledgeTaskResolution(input.taskId);

  return { success: true as const, changed };
}
