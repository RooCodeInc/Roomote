import type { EnvironmentSetupState } from '@roomote/types';
import { and, db, taskRuns, eq, isNull } from '@roomote/db/server';

/**
 * Track the real lifecycle of environment setup (repository setup commands +
 * Docker projects), which can keep running in the background after
 * `setupCompletedAt` is stamped and the agent has started.
 *
 * Writing `running` uses `WHERE environment_setup_state IS NULL` so a worker
 * retry/replay cannot regress a terminal state back to running. Terminal
 * states overwrite unconditionally (the latest settle wins).
 */
export async function updateTaskRunEnvironmentSetup(input: {
  runId: number;
  state: EnvironmentSetupState;
  completedAt?: Date;
}): Promise<void> {
  const { runId, state, completedAt } = input;

  const values = {
    environmentSetupState: state,
    ...(completedAt !== undefined
      ? { environmentSetupCompletedAt: completedAt }
      : {}),
  };

  const where =
    state === 'running'
      ? and(eq(taskRuns.id, runId), isNull(taskRuns.environmentSetupState))
      : eq(taskRuns.id, runId);

  await db.update(taskRuns).set(values).where(where);
}
