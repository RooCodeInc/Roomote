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
// Cover stale-heartbeat detection, the scheduled recovery pass, and enough
// margin for run finalization before falling through to resume or relaunch.
export const ACTIVE_PR_REVIEW_FOLLOW_UP_ATTEMPTS = 20;
export const ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_DELAY_MS = 15_000;
export const ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_WINDOW_MS =
  (ACTIVE_PR_REVIEW_FOLLOW_UP_ATTEMPTS - 1) *
  ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_DELAY_MS;
export const ACTIVE_PR_REVIEW_FOLLOW_UP_DEDUPLICATION_TTL_MS =
  ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS +
  ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_WINDOW_MS;
export const ACTIVE_PR_REVIEW_FOLLOW_UP_JOB_OPTIONS = {
  attempts: ACTIVE_PR_REVIEW_FOLLOW_UP_ATTEMPTS,
  backoff: {
    type: 'fixed' as const,
    delay: ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_DELAY_MS,
  },
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 24 * 3600 },
};

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
        defaultJobOptions: ACTIVE_PR_REVIEW_FOLLOW_UP_JOB_OPTIONS,
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
        ttl: ACTIVE_PR_REVIEW_FOLLOW_UP_DEDUPLICATION_TTL_MS,
        extend: true,
        replace: true,
      },
    },
  );
}
