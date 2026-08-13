import { randomUUID } from 'node:crypto';

import {
  MAX_TASK_WAIT_MS,
  MIN_TASK_WAIT_MS,
  RunStatus,
  isResumableTaskPayloadKind,
  isTaskResumeCapableComputeProvider,
} from '@roomote/types';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../db';
import { taskRuns, tasks } from '../schema';

const ACTIVE_WAIT_STATUSES = [RunStatus.Running, RunStatus.Idle] as const;

export type ScheduleTaskWaitResult =
  | { scheduled: true; waitUntil: Date }
  | {
      scheduled: false;
      reason:
        | 'missing'
        | 'not_active'
        | 'unsupported'
        | 'already_waiting'
        | 'invalid_duration';
      waitUntil: Date | null;
    };

export async function scheduleTaskWait(input: {
  runId: number;
  delayMs: number;
  reason: string;
  now?: Date;
}): Promise<ScheduleTaskWaitResult> {
  if (input.delayMs < MIN_TASK_WAIT_MS || input.delayMs > MAX_TASK_WAIT_MS) {
    return { scheduled: false, reason: 'invalid_duration', waitUntil: null };
  }

  const now = input.now ?? new Date();
  const waitUntil = new Date(now.getTime() + input.delayMs);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ run: taskRuns, task: tasks })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(eq(taskRuns.id, input.runId))
      .limit(1)
      .for('update');

    if (!row) {
      return { scheduled: false, reason: 'missing', waitUntil: null };
    }
    if (
      !ACTIVE_WAIT_STATUSES.includes(
        row.run.status as (typeof ACTIVE_WAIT_STATUSES)[number],
      )
    ) {
      return {
        scheduled: false,
        reason: 'not_active',
        waitUntil: row.run.waitUntil,
      };
    }
    if (
      !row.run.vendor ||
      !isResumableTaskPayloadKind(row.run.payloadKind) ||
      !isTaskResumeCapableComputeProvider(row.run.vendor)
    ) {
      return { scheduled: false, reason: 'unsupported', waitUntil: null };
    }
    if (row.run.waitUntil || row.run.sleepRequestedAt || row.run.snapshotId) {
      return {
        scheduled: false,
        reason: 'already_waiting',
        waitUntil: row.run.waitUntil,
      };
    }

    const [updated] = await tx
      .update(taskRuns)
      .set({ waitUntil, waitReason: input.reason })
      .where(
        and(
          eq(taskRuns.id, input.runId),
          inArray(taskRuns.status, [...ACTIVE_WAIT_STATUSES]),
          isNull(taskRuns.waitUntil),
          isNull(taskRuns.sleepRequestedAt),
          isNull(taskRuns.snapshotId),
        ),
      )
      .returning({ id: taskRuns.id });

    if (!updated) {
      return { scheduled: false, reason: 'not_active', waitUntil: null };
    }

    // Invalidate the pre-wait turn's goal generation without consuming a
    // continuation. The resumed run receives this fresh generation.
    if (row.task.goalStatus === 'active') {
      const generation = `goal-generation:${randomUUID()}`;
      await tx
        .update(tasks)
        .set({
          goalLastContinuationId: generation,
          goalGenerationIds: [generation],
          updatedAt: now,
        })
        .where(and(eq(tasks.id, row.task.id), eq(tasks.goalStatus, 'active')));
    }

    return { scheduled: true, waitUntil };
  });
}

export async function clearTaskWaitSchedule(input: {
  runId: number;
  waitUntil: Date;
}): Promise<void> {
  await db
    .update(taskRuns)
    .set({ waitUntil: null, waitReason: null })
    .where(
      and(
        eq(taskRuns.id, input.runId),
        eq(taskRuns.waitUntil, input.waitUntil),
        isNull(taskRuns.waitResumedAt),
      ),
    );
}
