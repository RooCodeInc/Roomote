import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';
import {
  isBuiltInWebhookAutomationKey,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';

export const BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME =
  'built-in-automation-webhooks';

export const builtInAutomationWebhookJobSchema = z.object({
  automationKey: z.custom<TriggerableBackgroundAutomationKey>(
    (value) =>
      typeof value === 'string' && isBuiltInWebhookAutomationKey(value),
  ),
  webhookInputJson: z.string().nullable(),
});

export type BuiltInAutomationWebhookJob = z.infer<
  typeof builtInAutomationWebhookJobSchema
>;

let builtInAutomationWebhookQueue: Queue<BuiltInAutomationWebhookJob> | null =
  null;

function getBuiltInAutomationWebhookQueue(): Queue<BuiltInAutomationWebhookJob> {
  builtInAutomationWebhookQueue ??= new Queue(
    BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        // The runner can launch work for one deployment before reporting an
        // error for another, so retrying the whole webhook could duplicate it.
        attempts: 1,
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 24 * 3_600 },
      },
    },
  );
  return builtInAutomationWebhookQueue;
}

export async function enqueueBuiltInAutomationWebhook(
  input: BuiltInAutomationWebhookJob,
): Promise<void> {
  const job = builtInAutomationWebhookJobSchema.parse(input);
  await getBuiltInAutomationWebhookQueue().add('run', job);
}
