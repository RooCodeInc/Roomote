import {
  db,
  tasks,
  markTaskStartParallelCountsEndedAtForTaskIds,
  getSessionForTask,
  touchSessionActivity,
  taskArtifacts,
  and,
  eq,
  inArray,
  isNull,
  sessions,
  sessionTasks,
} from '@roomote/db/server';

import { deleteArtifactsBatch } from '@/lib/server';

import type { UserAuthSuccess } from '@/types';

export async function deleteTasksCommand(
  auth: UserAuthSuccess,
  input: { taskIds: string[] },
) {
  // Any deployment member can delete tasks; deletion is a soft delete
  // (tasks.deletedAt) so satellites and artifact cleanup can still read the
  // rows.
  void auth;

  const whereConditions = [
    inArray(tasks.id, input.taskIds),
    isNull(tasks.deletedAt),
  ];

  const result = await db.transaction(async (tx) => {
    const tasksToDelete = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(...whereConditions));

    if (tasksToDelete.length === 0) {
      return { deletedTasks: [], artifactsDeleted: 0, artifactErrors: 0 };
    }

    const taskIdsToDelete = tasksToDelete.map((t) => t.id);
    const endedAt = new Date();

    // Query artifacts for these tasks so their S3 objects can be removed.
    const artifactsToDelete = await tx
      .select({
        id: taskArtifacts.id,
        taskId: taskArtifacts.taskId,
        path: taskArtifacts.path,
        version: taskArtifacts.version,
      })
      .from(taskArtifacts)
      .where(inArray(taskArtifacts.taskId, taskIdsToDelete));

    // Delete S3 objects before removing their retry metadata.
    let s3Result = { deleted: 0, errors: 0 };

    if (artifactsToDelete.length > 0) {
      s3Result = await deleteArtifactsBatch(
        artifactsToDelete.map((artifact) => ({
          taskId: artifact.taskId!,
          artifactId: artifact.id,
          path: artifact.path,
          version: artifact.version,
        })),
      );

      if (s3Result.errors > 0) {
        throw new Error(
          `Failed to delete ${s3Result.errors} artifact objects for tasks: ${taskIdsToDelete.join(', ')}`,
        );
      }
    }

    // Remove the taskArtifacts rows now that their S3 objects are deleted. The
    // task row is only soft-deleted (rows are retained for satellites), so the
    // artifact rows would otherwise dangle and point at missing S3 objects.
    if (artifactsToDelete.length > 0) {
      await tx
        .delete(taskArtifacts)
        .where(inArray(taskArtifacts.taskId, taskIdsToDelete));
    }

    await markTaskStartParallelCountsEndedAtForTaskIds(tx, {
      taskIds: taskIdsToDelete,
      endedAt,
    });

    // Soft delete: queries filter isNull(tasks.deletedAt).
    const deletedTasksResult = await tx
      .update(tasks)
      .set({ deletedAt: endedAt, updatedAt: endedAt })
      .where(and(...whereConditions))
      .returning({ id: tasks.id });

    const affectedSessions = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof getSessionForTask>>>
    >();
    for (const deletedTask of deletedTasksResult) {
      const session = await getSessionForTask(tx, deletedTask.id);
      if (session) affectedSessions.set(session.id, session);
    }
    for (const session of affectedSessions.values()) {
      await touchSessionActivity(tx, session.id, session.activityAt);

      // A session whose last task was just deleted (and that has no Fast
      // conversation) would linger on the dashboard as an empty card carrying
      // the deleted task's title. Archive it; users can unarchive.
      if (!session.fastConversationId && !session.archivedAt) {
        const [remaining] = await tx
          .select({ taskId: sessionTasks.taskId })
          .from(sessionTasks)
          .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
          .where(
            and(
              eq(sessionTasks.sessionId, session.id),
              isNull(tasks.deletedAt),
            ),
          )
          .limit(1);
        if (!remaining) {
          await tx
            .update(sessions)
            .set({ archivedAt: endedAt, updatedAt: endedAt })
            .where(eq(sessions.id, session.id));
        }
      }
    }

    return {
      deletedTasks: deletedTasksResult,
      artifactsDeleted: s3Result.deleted,
      artifactErrors: s3Result.errors,
    };
  });

  return { success: true as const, deletedCount: result.deletedTasks.length };
}
