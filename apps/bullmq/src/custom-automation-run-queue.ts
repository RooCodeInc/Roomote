import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  CUSTOM_AUTOMATION_RUN_JOB_NAME,
  CUSTOM_AUTOMATION_RUN_QUEUE_NAME,
  customAutomationRunJobSchema,
  runClaimedFastCustomAutomation,
  type CustomAutomationRunJob,
} from '@roomote/sdk/server';
import { db, recordCustomAutomationRunOutcome } from '@roomote/db/server';

import { getRedis } from './redis';

export function startCustomAutomationRunQueue() {
  const connection = getRedis();
  const queue = new Queue<CustomAutomationRunJob, void, string>(
    CUSTOM_AUTOMATION_RUN_QUEUE_NAME,
    { connection },
  );
  const worker = new Worker<CustomAutomationRunJob, void, string>(
    CUSTOM_AUTOMATION_RUN_QUEUE_NAME,
    async (job) => {
      if (job.name !== CUSTOM_AUTOMATION_RUN_JOB_NAME) {
        throw new Error(`Unknown custom automation job: ${job.name}`);
      }
      await runClaimedFastCustomAutomation(
        customAutomationRunJobSchema.parse(job.data),
      );
    },
    {
      connection,
      concurrency: 3,
      autorun: true,
      // A stalled Fast turn may already have posted externally; never replay it.
      maxStalledCount: 0,
    },
  );
  const queueEvents = new QueueEvents(CUSTOM_AUTOMATION_RUN_QUEUE_NAME, {
    connection,
  });

  worker.on('failed', (job, error) => {
    const parsed = customAutomationRunJobSchema.safeParse(job?.data);
    if (parsed.success) {
      void recordCustomAutomationRunOutcome(db, {
        id: parsed.data.automationId,
        status: 'failed',
        error: error.message,
        launchClaimedAt: new Date(parsed.data.launchClaimedAt),
      }).catch((finalizeError) =>
        console.error(
          '[CustomAutomationRunQueue] failed to finalize invocation:',
          finalizeError,
        ),
      );
    }
    console.error(
      `[CustomAutomationRunQueue] job ${job?.id} failed:`,
      error.message,
    );
  });
  worker.on('error', (error) =>
    console.error('[CustomAutomationRunQueue] worker error:', error),
  );

  return { queue, worker, queueEvents };
}
