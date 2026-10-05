import { createHash, timingSafeEqual } from 'node:crypto';

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
  webhookTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
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

export function hashBuiltInAutomationWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function matchesBuiltInAutomationWebhookToken(
  tokenDigest: string,
  token: string,
): boolean {
  const expectedDigest = Buffer.from(tokenDigest, 'hex');
  const actualDigest = Buffer.from(
    hashBuiltInAutomationWebhookToken(token),
    'hex',
  );
  return (
    expectedDigest.length === actualDigest.length &&
    timingSafeEqual(expectedDigest, actualDigest)
  );
}

export async function enqueueBuiltInAutomationWebhook(
  input: Omit<BuiltInAutomationWebhookJob, 'webhookTokenDigest'> & {
    webhookToken: string;
  },
): Promise<void> {
  const { webhookToken, ...jobInput } = input;
  const job = builtInAutomationWebhookJobSchema.parse({
    ...jobInput,
    webhookTokenDigest: hashBuiltInAutomationWebhookToken(webhookToken),
  });
  await getBuiltInAutomationWebhookQueue().add('run', job);
}
