import { Queue, Worker, type Job } from 'bullmq';

import { getBackgroundAutomationWebhookState } from '@roomote/db/server';
import {
  BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME,
  builtInAutomationWebhookJobSchema,
  matchesBuiltInAutomationWebhookToken,
  runAutomationNow,
  type BuiltInAutomationWebhookJob,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

export async function processBuiltInAutomationWebhookJob(
  job: Job<BuiltInAutomationWebhookJob>,
): Promise<void> {
  const data = builtInAutomationWebhookJobSchema.parse(job.data);
  const webhook = await getBackgroundAutomationWebhookState(data.automationKey);
  if (
    !webhook?.enabled ||
    !webhook.token ||
    !matchesBuiltInAutomationWebhookToken(
      data.webhookTokenDigest,
      webhook.token,
    )
  ) {
    console.warn(
      `[BuiltInAutomationWebhookQueue] Dropping revoked ${data.automationKey} webhook job ${job.id}`,
    );
    return;
  }

  const result = await runAutomationNow(data.automationKey, {
    context: {
      trigger: 'webhook',
      ...(data.webhookInputJson
        ? { webhookInputJson: data.webhookInputJson }
        : {}),
    },
  });

  if (result.outcome === 'failed') {
    console.error(
      `[BuiltInAutomationWebhookQueue] ${data.automationKey} failed: ${result.error}`,
    );
  } else if (result.outcome === 'skipped') {
    console.warn(
      `[BuiltInAutomationWebhookQueue] ${data.automationKey} skipped: ${result.reason}`,
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
