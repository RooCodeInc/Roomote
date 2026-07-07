import { Queue } from 'bullmq';
import { z } from 'zod';

import { db, recordCloudJobEvent } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import { SNAPSHOT_JOB_RETRY_OPTIONS } from '@roomote/types';

const QUEUE_NAME = 'snapshot-jobs';
const BLOCKING_SNAPSHOT_JOB_STATES = new Set([
  'active',
  'delayed',
  'prioritized',
  'waiting',
  'waiting-children',
]);

export const snapshotRequestSchema = z.object({
  cloudJobId: z.number(),
  sandboxId: z.string(),
  snapshotIntentId: z.string().optional(),
  triggerPath: z.string().optional(),
});

let snapshotQueue: Queue<z.infer<typeof snapshotRequestSchema>> | null = null;

function getSnapshotQueue(): Queue<z.infer<typeof snapshotRequestSchema>> {
  if (!snapshotQueue) {
    const redis = getRedis();

    snapshotQueue = new Queue<z.infer<typeof snapshotRequestSchema>>(
      QUEUE_NAME,
      {
        connection: redis,
        defaultJobOptions: {
          ...SNAPSHOT_JOB_RETRY_OPTIONS,
          removeOnComplete: { age: 3600, count: 100 },
          removeOnFail: { age: 24 * 3600 },
        },
      },
    );
  }

  return snapshotQueue;
}

/**
 * Enqueue a snapshot request for a running cloud job.
 *
 * The job will be processed by the BullMQ worker in apps/bullmq.
 */
export async function createSnapshot(
  request: z.infer<typeof snapshotRequestSchema>,
): Promise<boolean> {
  const queue = getSnapshotQueue();

  const snapshotIntentId =
    request.snapshotIntentId ?? `snapshot-${request.cloudJobId}`;
  const jobId = snapshotIntentId;

  // Check if job already exists.
  const existingJob = await queue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (BLOCKING_SNAPSHOT_JOB_STATES.has(state)) {
      await recordSnapshotRequestEvent({
        cloudJobId: request.cloudJobId,
        eventType: 'decision',
        message: `Ignored duplicate snapshot request because BullMQ job ${jobId} is already ${state}.`,
        details: {
          decision: 'duplicate_ignored',
          queueJobId: jobId,
          snapshotIntentId,
          triggerPath: request.triggerPath ?? null,
          existingState: state,
          sandboxId: request.sandboxId,
        },
      });

      console.log(
        `[SnapshotRequestQueue] duplicate request for job ${request.cloudJobId}, ignoring (state: ${state})`,
      );

      return false;
    }

    await existingJob.remove();

    await recordSnapshotRequestEvent({
      cloudJobId: request.cloudJobId,
      eventType: 'decision',
      message: `Removed previous BullMQ snapshot request ${jobId} in terminal state ${state}.`,
      details: {
        decision: 'previous_job_removed',
        queueJobId: jobId,
        snapshotIntentId,
        triggerPath: request.triggerPath ?? null,
        existingState: state,
        sandboxId: request.sandboxId,
      },
    });
  }

  try {
    await queue.add('create-snapshot', request, {
      jobId,
      ...SNAPSHOT_JOB_RETRY_OPTIONS,
    });

    await recordSnapshotRequestEvent({
      cloudJobId: request.cloudJobId,
      eventType: 'enqueued',
      message: `Enqueued BullMQ snapshot request ${jobId}.`,
      details: {
        queueJobId: jobId,
        snapshotIntentId,
        triggerPath: request.triggerPath ?? null,
        sandboxId: request.sandboxId,
      },
    });

    console.log(
      `[SnapshotRequestQueue] enqueued snapshot request for job ${request.cloudJobId}`,
    );

    return true;
  } catch (error) {
    await recordSnapshotRequestEvent({
      cloudJobId: request.cloudJobId,
      eventType: 'failed',
      message: `Failed to enqueue BullMQ snapshot request ${jobId}.`,
      details: {
        queueJobId: jobId,
        snapshotIntentId,
        triggerPath: request.triggerPath ?? null,
        sandboxId: request.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }
}

async function recordSnapshotRequestEvent(input: {
  cloudJobId: number;
  eventType: 'decision' | 'enqueued' | 'failed';
  message: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordCloudJobEvent(db, {
      cloudJobId: input.cloudJobId,
      source: 'snapshot_request',
      eventType: input.eventType,
      message: input.message,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[SnapshotRequestQueue] failed to persist event for job ${input.cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
