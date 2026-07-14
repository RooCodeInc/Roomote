import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';

/**
 * Shared enqueue pipeline for the per-surface suggested-tasks onboarding
 * follow-ups (Slack, Telegram, Teams). Every surface uses the same delayed
 * BullMQ job shape: a Redis `SET NX` claim plus a deterministic jobId keep
 * the follow-up to one send per destination and source task.
 *
 * The queue names, jobId prefixes, and claim-key formats are part of the
 * deployed contract: delayed jobs live in Redis for 24 hours, so renaming a
 * queue would orphan everything already scheduled. Keep the per-surface
 * names stable and change only the shared mechanics here.
 */
export const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_DELAY_MS = 24 * 60 * 60 * 1000;
const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_CLAIM_TTL_SECONDS = 5 * 60;

export type EnqueueSuggestedTasksOnboardingFollowupResult = {
  enqueued: boolean;
  reason?: string;
  jobId?: string;
};

function createSuggestedTasksOnboardingFollowupEnqueuer<
  Schema extends z.ZodTypeAny,
>({
  queueName,
  jobIdPrefix,
  requestSchema,
  buildJobIdParts,
}: {
  queueName: string;
  jobIdPrefix: string;
  requestSchema: Schema;
  buildJobIdParts: (request: z.infer<Schema>) => string[];
}): (
  input: z.infer<Schema>,
) => Promise<EnqueueSuggestedTasksOnboardingFollowupResult> {
  // Typed loosely because BullMQ's conditional name-type inference cannot
  // resolve against a generic schema type; `requestSchema.parse` guarantees
  // the payload shape before anything is added.
  let queue: Queue | null = null;

  function getQueue(): Queue {
    if (!queue) {
      queue = new Queue(queueName, {
        connection: getRedis(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 100 },
          removeOnFail: { age: 24 * 3600 },
        },
      });
    }

    return queue;
  }

  return async function enqueueSuggestedTasksOnboardingFollowup(
    input: z.infer<Schema>,
  ): Promise<EnqueueSuggestedTasksOnboardingFollowupResult> {
    const requestData = requestSchema.parse(input) as z.infer<Schema>;
    const jobId = [
      jobIdPrefix,
      ...buildJobIdParts(requestData).map((part) => encodeURIComponent(part)),
    ].join('-');
    const claimKey = `${jobIdPrefix}:scheduled:${jobId}`;
    const redis = getRedis();
    const claim = await redis.set(
      claimKey,
      jobId,
      'EX',
      SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_CLAIM_TTL_SECONDS,
      'NX',
    );

    if (claim !== 'OK') {
      return { enqueued: false, reason: 'already_scheduled', jobId };
    }

    const followupQueue = getQueue();
    const existingJob = await followupQueue.getJob(jobId);

    if (existingJob) {
      return { enqueued: false, reason: 'already_scheduled', jobId };
    }

    try {
      await followupQueue.add(
        'send-suggested-tasks-onboarding-followup',
        requestData,
        {
          jobId,
          delay: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_DELAY_MS,
        },
      );
    } catch (error) {
      await redis.del(claimKey);
      throw error;
    }

    return { enqueued: true, jobId };
  };
}

export const SLACK_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME =
  'slack-suggested-tasks-onboarding-followup-jobs';

export const slackSuggestedTasksOnboardingFollowupRequestSchema = z.object({
  slackTeamId: z.string(),
  slackUserId: z.string(),
  channelId: z.string(),
  threadTs: z.string(),
  sourceTaskId: z.string(),
});

export type SlackSuggestedTasksOnboardingFollowupRequest = z.infer<
  typeof slackSuggestedTasksOnboardingFollowupRequestSchema
>;

export const enqueueSlackSuggestedTasksOnboardingFollowup =
  createSuggestedTasksOnboardingFollowupEnqueuer({
    queueName: SLACK_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
    jobIdPrefix: 'slack-suggested-tasks-onboarding-followup',
    requestSchema: slackSuggestedTasksOnboardingFollowupRequestSchema,
    buildJobIdParts: (request) => [
      request.slackTeamId,
      request.slackUserId,
      request.sourceTaskId,
    ],
  });

export const TELEGRAM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME =
  'telegram-suggested-tasks-onboarding-followup-jobs';

export const telegramSuggestedTasksOnboardingFollowupRequestSchema = z.object({
  chatId: z.string(),
  threadId: z.string().optional(),
  introMessageId: z.string(),
  sourceTaskId: z.string(),
});

export type TelegramSuggestedTasksOnboardingFollowupRequest = z.infer<
  typeof telegramSuggestedTasksOnboardingFollowupRequestSchema
>;

export const enqueueTelegramSuggestedTasksOnboardingFollowup =
  createSuggestedTasksOnboardingFollowupEnqueuer({
    queueName: TELEGRAM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
    jobIdPrefix: 'telegram-suggested-tasks-onboarding-followup',
    requestSchema: telegramSuggestedTasksOnboardingFollowupRequestSchema,
    buildJobIdParts: (request) => [request.chatId, request.sourceTaskId],
  });

export const TEAMS_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME =
  'teams-suggested-tasks-onboarding-followup-jobs';

export const teamsSuggestedTasksOnboardingFollowupRequestSchema = z.object({
  conversationId: z.string(),
  serviceUrl: z.string(),
  introMessageId: z.string(),
  sourceTaskId: z.string(),
});

export type TeamsSuggestedTasksOnboardingFollowupRequest = z.infer<
  typeof teamsSuggestedTasksOnboardingFollowupRequestSchema
>;

export const enqueueTeamsSuggestedTasksOnboardingFollowup =
  createSuggestedTasksOnboardingFollowupEnqueuer({
    queueName: TEAMS_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
    jobIdPrefix: 'teams-suggested-tasks-onboarding-followup',
    requestSchema: teamsSuggestedTasksOnboardingFollowupRequestSchema,
    buildJobIdParts: (request) => [
      request.conversationId,
      request.sourceTaskId,
    ],
  });
