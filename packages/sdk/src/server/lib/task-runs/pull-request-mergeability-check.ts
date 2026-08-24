import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';

export const PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME =
  'pull-request-mergeability-check-jobs';
export const PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS = 45_000;
export const PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS = 60_000;

export const pullRequestMergeabilityCheckRequestSchema = z.object({
  installationId: z.number().int().positive(),
  repository: z.string().min(3),
  taskPullRequestIds: z.array(z.string().uuid()).min(1),
  deduplicationKey: z.string().min(1),
  retryAttempt: z.union([z.literal(0), z.literal(1)]),
  allowNotifiedConflictCheck: z.boolean().default(false),
});

export type PullRequestMergeabilityCheckRequest = z.infer<
  typeof pullRequestMergeabilityCheckRequestSchema
>;

let pullRequestMergeabilityQueue: Queue<PullRequestMergeabilityCheckRequest> | null =
  null;

function getPullRequestMergeabilityQueue(): Queue<PullRequestMergeabilityCheckRequest> {
  if (!pullRequestMergeabilityQueue) {
    pullRequestMergeabilityQueue = new Queue(
      PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME,
      {
        connection: getRedis(),
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: { age: 3_600, count: 100 },
          removeOnFail: { age: 24 * 3_600 },
        },
      },
    );
  }

  return pullRequestMergeabilityQueue;
}

export async function enqueuePullRequestMergeabilityCheck(
  input: PullRequestMergeabilityCheckRequest,
): Promise<void> {
  const data = pullRequestMergeabilityCheckRequestSchema.parse(input);
  const delay =
    data.retryAttempt === 0
      ? PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS
      : PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS;
  const deduplicationId = `pr-mergeability:${data.deduplicationKey}:attempt-${data.retryAttempt}`;
  const deduplicationTtl = delay + 60_000;

  await getPullRequestMergeabilityQueue().add('check-pr-mergeability', data, {
    delay,
    deduplication: {
      id: deduplicationId,
      ttl: deduplicationTtl,
      extend: true,
      replace: true,
    },
  });
}
