import { db, desc, eq, taskRunEvents } from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';
import { requireTaskAccess } from '@/lib/server/custom-automation-task-access';

const MAX_RUN_EVENTS = 500;

/**
 * Durable per-run audit and diagnostic events (task_run_events). This is the
 * read side of the worker's diagnostic recorder: sandbox logs do not survive
 * the sandbox, so post-mortems read these instead.
 */
export async function getTaskRunEventsCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
) {
  await requireTaskAccess(auth, input.taskId);
  const events = await db
    .select({
      id: taskRunEvents.id,
      runId: taskRunEvents.runId,
      source: taskRunEvents.source,
      eventType: taskRunEvents.eventType,
      message: taskRunEvents.message,
      details: taskRunEvents.details,
      createdAt: taskRunEvents.createdAt,
    })
    .from(taskRunEvents)
    .where(eq(taskRunEvents.taskId, input.taskId))
    // Newest first under the limit: diagnostics cluster at the end of a run,
    // and a busy task must never push them out of the window. Reversed after
    // the query so callers still get chronological order.
    .orderBy(desc(taskRunEvents.createdAt))
    .limit(MAX_RUN_EVENTS);

  return { events: events.reverse() };
}
