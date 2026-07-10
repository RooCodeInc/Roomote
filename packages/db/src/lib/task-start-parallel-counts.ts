import type { TaskPayloadKind } from '@roomote/types';
import { and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { DatabaseOrTransaction, DatabaseTransaction } from '../db';
import { taskStartParallelCounts, tasks } from '../schema';

export const DEFAULT_ACTIVE_TASK_WINDOW_SECONDS = 10 * 60;

type RecordTaskStartParallelCountInput = {
  runId: number;
  payloadKind: TaskPayloadKind;
  taskId: string;
  startedAt: Date;
  activityWindowSeconds?: number;
};

export async function recordTaskStartParallelCount(
  tx: DatabaseTransaction,
  input: RecordTaskStartParallelCountInput,
) {
  const activityWindowSeconds = Math.max(
    input.activityWindowSeconds ?? DEFAULT_ACTIVE_TASK_WINDOW_SECONDS,
    1,
  );
  const cutoffSeconds =
    Math.floor(input.startedAt.getTime() / 1000) - activityWindowSeconds;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('task-start-parallel-count'))`,
  );

  const [activeTaskCount] = await tx
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(
      and(gte(tasks.activityAt, cutoffSeconds), ne(tasks.id, input.taskId)),
    );

  const [createdLog] = await tx
    .insert(taskStartParallelCounts)
    .values({
      runId: input.runId,
      payloadKind: input.payloadKind,
      taskId: input.taskId,
      parallelCount: (activeTaskCount?.count ?? 0) + 1,
      activityWindowSeconds,
      startedAt: input.startedAt,
    })
    .returning();

  if (!createdLog) {
    throw new Error('Failed to create `task_start_parallel_counts` record.');
  }

  return createdLog;
}

export async function markTaskStartParallelCountEndedAt(
  dbOrTx: DatabaseOrTransaction,
  input: {
    runId: number;
    endedAt: Date;
  },
) {
  await dbOrTx
    .update(taskStartParallelCounts)
    .set({
      endedAt: input.endedAt,
    })
    .where(
      and(
        eq(taskStartParallelCounts.runId, input.runId),
        isNull(taskStartParallelCounts.endedAt),
      ),
    );
}

export async function markTaskStartParallelCountsEndedAtForTaskIds(
  dbOrTx: DatabaseOrTransaction,
  input: {
    taskIds: string[];
    endedAt: Date;
  },
) {
  if (input.taskIds.length === 0) {
    return;
  }

  await dbOrTx
    .update(taskStartParallelCounts)
    .set({
      endedAt: input.endedAt,
    })
    .where(
      and(
        inArray(taskStartParallelCounts.taskId, input.taskIds),
        isNull(taskStartParallelCounts.endedAt),
      ),
    );
}
