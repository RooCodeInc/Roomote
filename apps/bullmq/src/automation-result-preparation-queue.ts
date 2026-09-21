import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  AUTOMATION_RESULT_PREPARATION_ATTEMPTS,
  AUTOMATION_RESULT_PREPARATION_QUEUE_NAME,
  processAutomationResultPreparation,
  recoverPendingAutomationResultPreparations,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

export async function startAutomationResultPreparationQueue() {
  const connection = getRedis();
  const queue = new Queue(AUTOMATION_RESULT_PREPARATION_QUEUE_NAME, {
    connection,
  });
  const worker = new Worker<{ resultId?: string }>(
    AUTOMATION_RESULT_PREPARATION_QUEUE_NAME,
    (job) =>
      job.data.resultId
        ? processAutomationResultPreparation({
            resultId: job.data.resultId,
            finalAttempt:
              job.attemptsMade + 1 >=
              (job.opts.attempts ?? AUTOMATION_RESULT_PREPARATION_ATTEMPTS),
          })
        : recoverPendingAutomationResultPreparations(),
    { connection, concurrency: 3, autorun: true },
  );
  const queueEvents = new QueueEvents(
    AUTOMATION_RESULT_PREPARATION_QUEUE_NAME,
    { connection },
  );

  worker.on('failed', (job, error) => {
    console.error(
      `[AutomationResultPreparationQueue] job ${job?.id} failed:`,
      error.message,
    );
  });
  worker.on('error', (error) => {
    console.error('[AutomationResultPreparationQueue] worker error:', error);
  });

  await recoverPendingAutomationResultPreparations();
  await queue.upsertJobScheduler(
    'automation-result-preparation-recovery',
    { every: 5 * 60_000 },
    { name: 'recover', data: {} },
  );
  console.log('[AutomationResultPreparationQueue] Started worker');
  return { queue, worker, queueEvents };
}
