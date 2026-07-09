import { and, eq, ne } from 'drizzle-orm';
import { CloudTaskStatus, type TaskState } from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { taskRuns, tasks } from '../schema';

/**
 * Run statuses that keep the owning task 'active': the sandbox is still (or
 * could still become) alive. Idle counts as non-terminal because the machine
 * stays up waiting for interaction.
 */
const NON_TERMINAL_RUN_STATUSES = new Set<CloudTaskStatus>([
  CloudTaskStatus.Pending,
  CloudTaskStatus.Dequeued,
  CloudTaskStatus.Processing,
  CloudTaskStatus.Preparing,
  CloudTaskStatus.Spawning,
  CloudTaskStatus.Connecting,
  CloudTaskStatus.Running,
  CloudTaskStatus.Idle,
]);

/**
 * Minimal per-run shape the task-state derivation needs. All resume attempts
 * share the same task row, so the derivation always considers every sibling
 * run, not just the one that triggered the sync.
 */
export type TaskStateRunInput = {
  id: number;
  status: CloudTaskStatus;
  startedAt: Date | null;
};

function terminalRunStatusToTaskState(status: CloudTaskStatus): TaskState {
  switch (status) {
    case CloudTaskStatus.Failed:
      return 'failed';
    case CloudTaskStatus.Canceled:
      return 'canceled';
    default:
      // Only terminal statuses (completed/failed/canceled) reach here; the
      // completed case is the natural default.
      return 'completed';
  }
}

/**
 * Derives the durable `tasks.state` from the task's runs:
 * 1. Any non-terminal run (incl. idle) -> 'active'.
 * 2. Otherwise pick the most meaningful terminal run: the latest run (highest
 *    id) that made progress (startedAt set OR status='completed'); if none
 *    made progress, the latest run overall. Map its status to the task state.
 *
 * Returns null when there are no runs (nothing to derive).
 */
export function deriveTaskStateFromRuns(
  runs: TaskStateRunInput[],
): TaskState | null {
  if (runs.length === 0) {
    return null;
  }

  const hasNonTerminalRun = runs.some((run) =>
    NON_TERMINAL_RUN_STATUSES.has(run.status),
  );

  if (hasNonTerminalRun) {
    return 'active';
  }

  const madeProgress = (run: TaskStateRunInput): boolean =>
    run.startedAt !== null || run.status === CloudTaskStatus.Completed;

  const progressRuns = runs.filter(madeProgress);
  const candidates = progressRuns.length > 0 ? progressRuns : runs;
  const chosen = candidates.reduce((latest, run) =>
    run.id > latest.id ? run : latest,
  );

  return terminalRunStatusToTaskState(chosen.status);
}

/**
 * Shared writer for `tasks.state`. Every terminal/cancel writer routes through
 * here so the durable task state is always DERIVED from the full set of the
 * task's runs rather than blindly stamped by whichever run finished last. This
 * keeps resume runs honest: a failed-bootstrap resume can no longer clobber an
 * already-completed task, an idle sibling keeps the task active regardless of
 * which sibling finishes, and a cancel-before-start of an only-run still
 * resolves the task to 'canceled'.
 *
 * Writes `state` (+`updatedAt`) only when it actually changes.
 *
 * MUST be called inside the same transaction that wrote the run-status change
 * this sync reflects (`tx` is a transaction, never a bare connection). The
 * derivation reads every sibling run, so two sibling runs finishing
 * concurrently could otherwise each miss the other's still-uncommitted terminal
 * write under READ COMMITTED, both derive 'active', and leave the task stuck
 * 'active' after both commit. To serialize, this acquires a `SELECT ... FOR
 * UPDATE` row lock on the owning `tasks` row before reading the runs: the second
 * transaction blocks on the lock until the first commits, and because each
 * statement takes a fresh snapshot under READ COMMITTED its subsequent runs read
 * then sees the committed sibling status.
 */
export async function syncTaskStateFromRuns(
  tx: DatabaseOrTransaction,
  taskId: string,
): Promise<void> {
  // Serialize concurrent sibling-run syncs on the owning task row. This lock is
  // only meaningful inside a transaction (the invariant above); it is released
  // when that transaction commits/rolls back.
  await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for('update');

  const runs = await tx
    .select({
      id: taskRuns.id,
      status: taskRuns.status,
      startedAt: taskRuns.startedAt,
    })
    .from(taskRuns)
    .where(eq(taskRuns.taskId, taskId));

  const nextState = deriveTaskStateFromRuns(runs);

  if (nextState === null) {
    return;
  }

  await tx
    .update(tasks)
    .set({ state: nextState, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), ne(tasks.state, nextState)));
}
