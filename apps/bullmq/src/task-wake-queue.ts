import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import {
  enqueueTask,
  TaskRunQueueEnqueueError,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  isNull,
  releaseTaskWaitResume,
  sql,
  taskRuns,
} from '@roomote/db/server';
import {
  TASK_WAKE_QUEUE_NAME,
  taskWakeRequestSchema,
  type TaskWakeRequest,
} from '@roomote/sdk/server';
import {
  ALL_REPOSITORIES,
  isExitedRunStatus,
  isSnapshotResumable,
  populateSnapshotResumeCommunicationMetadata,
  populateSnapshotResumeSlackMetadata,
  restoreSnapshotResumeVisiblePromptFields,
  RunStatus,
  TaskPayloadKind,
  type TaskPayload,
} from '@roomote/types';

import { getRedis } from './redis';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function wakeTaskJob(
  job: Job<TaskWakeRequest, void, string>,
): Promise<void> {
  const request = taskWakeRequestSchema.parse(job.data);
  const waitUntil = new Date(request.waitUntil);
  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, request.runId),
  });

  if (
    !sourceRun ||
    !sourceRun.waitUntil ||
    sourceRun.waitUntil.getTime() !== waitUntil.getTime()
  ) {
    return;
  }
  if (sourceRun.waitResumedAt || sourceRun.waitResumeRunId) {
    const claimedRun = sourceRun.waitResumeRunId
      ? await db.query.taskRuns.findFirst({
          where: eq(taskRuns.id, sourceRun.waitResumeRunId),
          columns: { status: true },
        })
      : null;
    if (
      !sourceRun.waitResumeRunId ||
      claimedRun?.status !== RunStatus.Canceled
    ) {
      return;
    }
    const released = await releaseTaskWaitResume({
      runId: sourceRun.id,
      waitUntil,
      resumeRunId: sourceRun.waitResumeRunId,
    });
    if (!released) return;
  }
  if (Date.now() < sourceRun.waitUntil.getTime()) {
    throw new Error(`Task wait for run #${sourceRun.id} is not due yet`);
  }
  if (!isExitedRunStatus(sourceRun.status)) {
    throw new Error(`Task run #${sourceRun.id} is not asleep yet`);
  }
  if (
    !sourceRun.snapshotId ||
    !isSnapshotResumable(sourceRun.snapshotCreatedAt)
  ) {
    throw new Error(`Task run #${sourceRun.id} has no resumable snapshot`);
  }

  const sourcePayload = sourceRun.payload as Record<string, unknown>;
  const resumePayload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
    repo: optionalString(sourcePayload.repo) ?? ALL_REPOSITORIES,
    ...(optionalString(sourcePayload.environmentId)
      ? { environmentId: optionalString(sourcePayload.environmentId) }
      : {}),
    ...(sourceRun.port ? { port: sourceRun.port } : {}),
    sourceSnapshotId: sourceRun.snapshotId,
    sourceRunId: sourceRun.id,
    resumePrompt: `<task_wait_elapsed>\nThe explicit wait requested by the user has elapsed. Continue the same task now.\n\nRequested follow-up: ${sourceRun.waitReason ?? 'Continue the prior work.'}\n</task_wait_elapsed>`,
    resumePromptSource: 'task-wait',
    resumePromptClientMessageId: `task-wait:${sourceRun.id}:${request.waitUntil}`,
    taskWaitWake: true,
  };
  const selectedRepositories = Array.isArray(sourcePayload.selectedRepositories)
    ? sourcePayload.selectedRepositories.filter(
        (value): value is string => typeof value === 'string',
      )
    : undefined;
  if (selectedRepositories?.length) {
    resumePayload.selectedRepositories = selectedRepositories;
  }
  populateSnapshotResumeSlackMetadata(resumePayload, {
    sourcePayload,
  });
  populateSnapshotResumeCommunicationMetadata(resumePayload, {
    sourcePayload,
  });
  restoreSnapshotResumeVisiblePromptFields(resumePayload, sourcePayload);

  try {
    await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: sourceRun.snapshotId,
          sourceRunId: sourceRun.id,
          payload: resumePayload,
        },
        actingUserId: sourceRun.actingUserId,
      },
      {
        launchClass: 'human',
        afterCreateInTransaction: async (tx, resumeRun) => {
          await tx.execute(
            sql`SELECT id FROM task_runs WHERE id = ${sourceRun.id} FOR UPDATE`,
          );
          const [claimed] = await tx
            .update(taskRuns)
            .set({ waitResumedAt: new Date(), waitResumeRunId: resumeRun.id })
            .where(
              and(
                eq(taskRuns.id, sourceRun.id),
                eq(taskRuns.waitUntil, waitUntil),
                isNull(taskRuns.waitResumedAt),
                isNull(taskRuns.waitResumeRunId),
              ),
            )
            .returning({ id: taskRuns.id });
          if (!claimed) {
            throw new Error(
              `Task wait for run #${sourceRun.id} was already resumed`,
            );
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof TaskRunQueueEnqueueError) {
      await releaseTaskWaitResume({
        runId: sourceRun.id,
        waitUntil,
        resumeRunId: error.runId,
      });
    }
    throw error;
  }
}

export function startTaskWakeQueue() {
  const connection = getRedis();
  const queue = new Queue<TaskWakeRequest, void, string>(TASK_WAKE_QUEUE_NAME, {
    connection,
  });
  const worker = new Worker<TaskWakeRequest, void, string>(
    TASK_WAKE_QUEUE_NAME,
    wakeTaskJob,
    { connection, concurrency: 5, autorun: true },
  );
  const queueEvents = new QueueEvents(TASK_WAKE_QUEUE_NAME, { connection });

  worker.on('failed', (job, error) => {
    console.error(
      `[TaskWakeQueue] job ${job?.id} failed for task run #${job?.data.runId}:`,
      error.message,
    );
  });
  worker.on('error', (error) => {
    console.error('[TaskWakeQueue] worker error:', error);
  });

  return { queue, worker, queueEvents };
}
