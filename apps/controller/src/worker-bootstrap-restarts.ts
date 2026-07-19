import { RunStatus } from '@roomote/types';
import {
  and,
  asc,
  db,
  eq,
  exists,
  isNull,
  sql,
  taskRunEvents,
  taskRuns,
} from '@roomote/db/server';

type SelectDatabase = Pick<typeof db, 'select'>;

export function buildPersistedWorkerBootstrapRestartsQuery(
  database: SelectDatabase = db,
) {
  const matchingRestartEvent = database
    .select({ id: taskRunEvents.id })
    .from(taskRunEvents)
    .where(
      and(
        eq(taskRunEvents.runId, taskRuns.id),
        eq(taskRunEvents.source, 'run_lifecycle'),
        sql`${taskRunEvents.details} ->> 'stage' = 'worker_bootstrap_restart'`,
      ),
    );

  // Use the core query builder here. The relational query builder aliases the
  // outer task_runs table and remaps columns inside correlated raw SQL, which
  // can incorrectly turn task_run_events.run_id into taskRuns.run_id.
  return database
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.status, RunStatus.Pending),
        isNull(taskRuns.startedAt),
        isNull(taskRuns.canceledAt),
        exists(matchingRestartEvent),
      ),
    )
    .orderBy(asc(taskRuns.createdAt));
}

export async function findPersistedWorkerBootstrapRestarts() {
  return buildPersistedWorkerBootstrapRestartsQuery();
}
