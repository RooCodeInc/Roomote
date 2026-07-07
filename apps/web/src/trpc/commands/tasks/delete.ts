import {
  db,
  tasks,
  deletedTasks,
  markTaskStartParallelCountsEndedAtForTaskIds,
  taskArtifacts,
  eq,
  and,
  inArray,
} from '@roomote/db/server';

import { deleteArtifactsBatch } from '@/lib/server';

import type { UserAuthSuccess } from '@/types';

export async function deleteTasksCommand(
  auth: UserAuthSuccess,
  input: { taskIds: string[] },
) {
  const { userId: authUserId, isAdmin } = auth;

  // Build where conditions based on user permissions.
  const whereConditions = [inArray(tasks.id, input.taskIds)];

  // Non-admins can ONLY delete their own tasks.
  if (!isAdmin) {
    whereConditions.push(eq(tasks.userId, authUserId));
  }

  // Use a transaction to track deletions and delete tasks.
  const result = await db.transaction(async (tx) => {
    // First, get the tasks that will be deleted to track them.
    const tasksToDelete = await tx
      .select({ id: tasks.id, userId: tasks.userId })
      .from(tasks)
      .where(and(...whereConditions));

    if (tasksToDelete.length === 0) {
      return { deletedTasks: [], artifactsDeleted: 0, artifactErrors: 0 };
    }

    const taskIdsToDelete = tasksToDelete.map((t) => t.id);
    const endedAt = new Date();

    // Query artifacts for these tasks BEFORE deleting them.
    const artifactsToDelete = await tx
      .select({
        id: taskArtifacts.id,
        taskId: taskArtifacts.taskId,
        path: taskArtifacts.path,
        version: taskArtifacts.version,
      })
      .from(taskArtifacts)
      .where(inArray(taskArtifacts.taskId, taskIdsToDelete));

    // Delete S3 objects for these artifacts (best-effort).
    let s3Result = { deleted: 0, errors: 0 };

    if (artifactsToDelete.length > 0) {
      try {
        s3Result = await deleteArtifactsBatch(
          artifactsToDelete.map((artifact) => ({
            taskId: artifact.taskId,
            artifactId: artifact.id,
            path: artifact.path,
            version: artifact.version,
          })),
        );

        if (s3Result.errors > 0) {
          console.warn(
            `[deleteTasksCommand] S3 deletion had ${s3Result.errors} errors for tasks: ${taskIdsToDelete.join(', ')}`,
          );
        }
      } catch (s3Error) {
        console.error('[deleteTasksCommand] S3 deletion error:', s3Error);
      }
    }

    await markTaskStartParallelCountsEndedAtForTaskIds(tx, {
      taskIds: taskIdsToDelete,
      endedAt,
    });

    // Insert records into deleted_tasks table for audit trail.
    await tx.insert(deletedTasks).values(
      tasksToDelete.map((task) => ({
        taskId: task.id,
        userId: task.userId,
      })),
    );

    // Delete the tasks (cascade will delete artifact DB records).
    const deletedTasksResult = await tx
      .delete(tasks)
      .where(and(...whereConditions))
      .returning({ id: tasks.id });

    return {
      deletedTasks: deletedTasksResult,
      artifactsDeleted: s3Result.deleted,
      artifactErrors: s3Result.errors,
    };
  });

  return { success: true as const, deletedCount: result.deletedTasks.length };
}
