import { Queue, Worker, type Job } from 'bullmq';

import {
  BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME,
  runAutomationNow,
  type BuiltInAutomationWebhookJob,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

async function processBuiltInAutomationWebhookJob(
  job: Job<BuiltInAutomationWebhookJob>,
): Promise<void> {
  const result = await runAutomationNow(job.data.automationKey, {
    trigger: 'webhook',
    ...(job.data.webhookInputJson
      ? { webhookInputJson: job.data.webhookInputJson }
      : {}),
  });

  if (result.outcome === 'failed') {
    console.error(
      `[BuiltInAutomationWebhookQueue] ${job.data.automationKey} failed: ${result.error}`,
    );
  } else if (result.outcome === 'skipped') {
    console.warn(
      `[BuiltInAutomationWebhookQueue] ${job.data.automationKey} skipped: ${result.reason}`,
    );
  }
}

export function startBuiltInAutomationWebhooksQueue() {
  const connection = getRedis();
  const queue = new Queue<BuiltInAutomationWebhookJob>(
    BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME,
    { connection },
  );
  const worker = new Worker<BuiltInAutomationWebhookJob>(
    BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME,
    processBuiltInAutomationWebhookJob,
    { connection, concurrency: 5, autorun: true },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[BuiltInAutomationWebhookQueue] job ${job?.id} failed:`,
      error,
    ),
  );
  worker.on('error', (error) =>
    console.error('[BuiltInAutomationWebhookQueue] worker error:', error),
  );

  return { queue, worker };
}
