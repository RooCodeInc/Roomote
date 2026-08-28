import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';

export const PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME =
  'pull-request-mergeability-check-jobs';
export const PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS = 45_000;
export const PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS = 60_000;

export const pullRequestMergeabilityCheckRequestSchema = z
  .object({
    installationId: z.number().int().positive(),
    repository: z.string().min(3),
    // Scope is resolved by the job at run time so tracked rows inserted after
    // the webhook (opened events race the task's own PR persistence) are
    // still picked up.
    baseRef: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
    taskPullRequestIds: z.array(z.string().uuid()).min(1).optional(),
    deduplicationKey: z.string().min(1),
    retryAttempt: z.union([z.literal(0), z.literal(1)]),
    allowNotifiedConflictCheck: z.boolean().default(false),
  })
  .refine(
    (data) =>
      data.baseRef !== undefined ||
      data.prNumber !== undefined ||
      data.taskPullRequestIds !== undefined,
    {
      message:
        'A mergeability check requires a baseRef, prNumber, or taskPullRequestIds scope.',
    },
  );

export type PullRequestMergeabilityCheckRequest = z.infer<
  typeof pullRequestMergeabilityCheckRequestSchema
>;

/** The one user-facing conflict sentence shared by chat and Fast-parent notifications. */
export function buildPullRequestConflictMessage(params: {
  title: string;
  url: string;
}): string {
  return `[${params.title}](${params.url}) now has merge conflicts. Update the branch or ask Roomote to resolve them.`;
}

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

  await getPullRequestMergeabilityQueue().add('check-pr-mergeability', data, {
    delay,
    deduplication: {
      id: deduplicationId,
      // The key must not outlive the job's promotion: BullMQ only replaces
      // DELAYED jobs, so a longer TTL would silently drop pushes that arrive
      // while the job runs or shortly after it completes.
      ttl: delay,
      extend: true,
      replace: true,
    },
  });
}
