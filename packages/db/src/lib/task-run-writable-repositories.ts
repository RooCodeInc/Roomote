import { and, eq, isNull } from 'drizzle-orm';

import type { DatabaseOrTransaction } from '../db';
import type { Repository, TaskRun } from '../index';
import { environments, repositories, taskRuns, tasks, users } from '../schema';
import { getTaskHumanOwnerUserIds } from './sessions';

/** Environment preparation is not a repository authorization boundary. */
export async function resolveTaskRunWritableRepositories(
  dbOrTx: DatabaseOrTransaction,
  taskRun: Pick<TaskRun, 'id' | 'payload'>,
): Promise<Repository[] | null> {
  if (!taskRun.payload.environmentId) {
    // Explicit non-environment selections retain their existing scope.
    return null;
  }

  const run = await dbOrTx.query.taskRuns.findFirst({
    where: eq(taskRuns.id, taskRun.id),
    columns: { actingUserId: true, taskId: true },
  });
  if (!run) {
    throw new Error(`Task run not found: ${taskRun.id}`);
  }

  const actorUserId =
    run.actingUserId ?? (await getTaskHumanOwnerUserIds(dbOrTx, run.taskId))[0];
  if (actorUserId) {
    const member = await dbOrTx.query.users.findFirst({
      where: and(eq(users.id, actorUserId), isNull(users.deletedAt)),
      columns: { id: true },
    });
    if (!member) {
      throw new Error(
        `The acting user for task run ${taskRun.id} is not an active deployment member.`,
      );
    }
  } else {
    const task = await dbOrTx.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: { initiatorKind: true },
    });
    if (task?.initiatorKind !== 'automation') {
      throw new Error(
        `Task run ${taskRun.id} requires an active deployment member or a trusted deployment automation.`,
      );
    }
  }
  // There is no repository-level user ACL; repository.userId records sync ownership.
  const environment = await dbOrTx.query.environments.findFirst({
    where: eq(environments.id, taskRun.payload.environmentId),
    columns: { id: true },
  });
  if (!environment) {
    throw new Error(
      `Environment not found for task run ${taskRun.id}: ${taskRun.payload.environmentId}`,
    );
  }

  return dbOrTx.query.repositories.findMany({
    where: eq(repositories.isActive, true),
  });
}
