import { asc, db, eq, taskRunEvents } from '@roomote/db/server';

const MAX_RUN_EVENTS = 500;

/**
 * Durable per-run audit and diagnostic events (task_run_events). This is the
 * read side of the worker's diagnostic recorder: sandbox logs do not survive
 * the sandbox, so post-mortems read these instead.
 */
export async function getTaskRunEventsCommand(input: { taskId: string }) {
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
    .orderBy(asc(taskRunEvents.createdAt))
    .limit(MAX_RUN_EVENTS);

  return { events };
}
