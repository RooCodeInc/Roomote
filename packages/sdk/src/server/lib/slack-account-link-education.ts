import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';

export const SLACK_ACCOUNT_LINK_EDUCATION_QUEUE_NAME =
  'slack-account-link-education-jobs';
export const SLACK_ACCOUNT_LINK_EDUCATION_DELAY_MS = 60 * 60 * 1000;
const SLACK_ACCOUNT_LINK_EDUCATION_CLAIM_TTL_SECONDS = 5 * 60;

export const slackAccountLinkEducationRequestSchema = z.object({
  slackTeamId: z.string(),
  slackUserId: z.string(),
  userId: z.string(),
  mappingLinkedAt: z.coerce.date().optional(),
});

export type SlackAccountLinkEducationRequest = z.infer<
  typeof slackAccountLinkEducationRequestSchema
>;

export const enqueueSlackAccountLinkEducationInputSchema = z.object({
  slackTeamId: z.string(),
  slackUserId: z.string(),
  userId: z.string(),
  mappingLinkedAt: z.coerce.date().optional(),
});

export type EnqueueSlackAccountLinkEducationInput = z.infer<
  typeof enqueueSlackAccountLinkEducationInputSchema
>;

export type EnqueueSlackAccountLinkEducationResult = {
  enqueued: boolean;
  reason?: string;
  jobId?: string;
};

let slackAccountLinkEducationQueue: Queue<SlackAccountLinkEducationRequest> | null =
  null;

function getSlackAccountLinkEducationQueue(): Queue<SlackAccountLinkEducationRequest> {
  if (!slackAccountLinkEducationQueue) {
    const redis = getRedis();

    slackAccountLinkEducationQueue =
      new Queue<SlackAccountLinkEducationRequest>(
        SLACK_ACCOUNT_LINK_EDUCATION_QUEUE_NAME,
        {
          connection: redis,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { age: 3600, count: 100 },
            removeOnFail: { age: 24 * 3600 },
          },
        },
      );
  }

  return slackAccountLinkEducationQueue;
}

function encodeJobPart(value: string): string {
  return encodeURIComponent(value);
}

function buildSlackAccountLinkEducationJobId(
  input: EnqueueSlackAccountLinkEducationInput,
): string {
  const jobParts = [
    'slack-account-link-education',
    encodeJobPart(input.slackTeamId),
    encodeJobPart(input.slackUserId),
    encodeJobPart(input.userId),
  ];

  // Link/relink events should be able to reset the delay window even if the
  // same team/slackUser/user tuple appears again.
  if (input.mappingLinkedAt) {
    jobParts.push(encodeJobPart(String(input.mappingLinkedAt.getTime())));
  }

  return jobParts.join('-');
}

function buildSlackAccountLinkEducationClaimKey(jobId: string): string {
  return `slack-account-link-education:scheduled:${jobId}`;
}

export async function enqueueSlackAccountLinkEducation(
  input: EnqueueSlackAccountLinkEducationInput,
): Promise<EnqueueSlackAccountLinkEducationResult> {
  const parsedInput = enqueueSlackAccountLinkEducationInputSchema.parse(input);
  const requestData = slackAccountLinkEducationRequestSchema.parse(parsedInput);
  const queue = getSlackAccountLinkEducationQueue();
  const redis = getRedis();
  const jobId = buildSlackAccountLinkEducationJobId(parsedInput);
  const claimKey = buildSlackAccountLinkEducationClaimKey(jobId);
  const claim = await redis.set(
    claimKey,
    jobId,
    'EX',
    SLACK_ACCOUNT_LINK_EDUCATION_CLAIM_TTL_SECONDS,
    'NX',
  );

  if (claim !== 'OK') {
    return { enqueued: false, reason: 'already_scheduled', jobId };
  }

  const existingJob = await queue.getJob(jobId);

  if (existingJob) {
    return { enqueued: false, reason: 'already_scheduled', jobId };
  }

  try {
    await queue.add('send-account-link-education', requestData, {
      jobId,
      delay: SLACK_ACCOUNT_LINK_EDUCATION_DELAY_MS,
    });
  } catch (error) {
    await redis.del(claimKey);
    throw error;
  }

  return { enqueued: true, jobId };
}
