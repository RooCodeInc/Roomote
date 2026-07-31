import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';
import {
  githubPullRequestReviewSyncSchema,
  sourceControlProviderSchema,
} from '@roomote/types';

export const ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME =
  'active-pr-review-follow-up-jobs';
export const ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS = 5_000;

const taskPrLinkageSchema = z.object({
  provider: sourceControlProviderSchema,
  host: z.string().nullish(),
  repositoryId: z.string().nullish(),
  repository: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string(),
  prTitle: z.string().nullish(),
  prSha: z.string().nullish(),
  prBaseRef: z.string().nullish(),
  prBaseSha: z.string().nullish(),
});

export const activePrReviewFollowUpRequestSchema = z.object({
  runId: z.number().int().positive(),
  taskId: z.string(),
  sandboxServerUrl: z.string(),
  repository: z.string(),
  prNumber: z.number().int().positive(),
  previousHeadSha: z.string().nullable(),
  eventHeadSha: z.string(),
  fallback: z.object({
    task: githubPullRequestReviewSyncSchema,
    initiatorActor: z.object({
      externalId: z.string(),
      displayName: z.string(),
    }),
    prLinkage: taskPrLinkageSchema,
  }),
});

export type ActivePrReviewFollowUpRequest = z.infer<
  typeof activePrReviewFollowUpRequestSchema
>;

let activePrReviewFollowUpQueue: Queue<ActivePrReviewFollowUpRequest> | null =
  null;

function getActivePrReviewFollowUpQueue(): Queue<ActivePrReviewFollowUpRequest> {
  if (!activePrReviewFollowUpQueue) {
    activePrReviewFollowUpQueue = new Queue<ActivePrReviewFollowUpRequest>(
      ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME,
      {
        connection: getRedis(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 100 },
          removeOnFail: { age: 24 * 3600 },
        },
      },
    );
  }

  return activePrReviewFollowUpQueue;
}

/**
 * Debounces synchronize events for one active review run. BullMQ replaces the
 * delayed job and extends its delay, so a burst of commits becomes one
 * follow-up containing the newest observed head.
 */
export async function enqueueActivePrReviewFollowUp(
  input: ActivePrReviewFollowUpRequest,
): Promise<void> {
  const data = activePrReviewFollowUpRequestSchema.parse(input);
  const deduplicationId = `active-pr-review-follow-up:${data.runId}`;

  await getActivePrReviewFollowUpQueue().add(
    'queue-active-pr-review-follow-up',
    data,
    {
      delay: ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
      deduplication: {
        id: deduplicationId,
        ttl: ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
        extend: true,
        replace: true,
      },
    },
  );
}
