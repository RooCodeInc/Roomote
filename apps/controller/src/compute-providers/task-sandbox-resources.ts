import type { TaskRun } from '@roomote/db/server';
import { db, eq, tasks } from '@roomote/db/server';
import {
  type EnvironmentConfig,
  TASK_SANDBOX_DEFAULT_MEMORY_MIB,
  TASK_SANDBOX_DOCKER_MEMORY_MIB,
} from '@roomote/types';

/**
 * Setup tasks need Docker before an environment config exists; established
 * environments advertise the same requirement through docker_projects.
 */
export async function taskNeedsNestedDocker(
  taskRun: TaskRun,
  environmentConfig: EnvironmentConfig | undefined,
): Promise<boolean> {
  if (environmentConfig) {
    return (
      environmentConfig.nested_docker === true ||
      Boolean(environmentConfig.docker_projects?.length)
    );
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskRun.taskId),
    columns: { workflow: true },
  });

  return task?.workflow === 'setup_onboarding';
}

export async function resolveTaskSandboxMemoryMiB(
  taskRun: TaskRun,
  environmentConfig: EnvironmentConfig | undefined,
): Promise<{
  needsNestedDocker: boolean;
  memoryMiB: number;
}> {
  const needsNestedDocker = await taskNeedsNestedDocker(
    taskRun,
    environmentConfig,
  );

  return {
    needsNestedDocker,
    memoryMiB: needsNestedDocker
      ? TASK_SANDBOX_DOCKER_MEMORY_MIB
      : TASK_SANDBOX_DEFAULT_MEMORY_MIB,
  };
}
