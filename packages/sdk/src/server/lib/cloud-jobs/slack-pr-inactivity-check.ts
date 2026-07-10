import { Queue } from 'bullmq';
import { z } from 'zod';

import type { Run } from '@roomote/db/server';
import {
  and,
  db,
  desc,
  eq,
  isNotNull,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import { createCloudJobGitHubToken, getOctokit } from '@roomote/github';
import { getRedis } from '@roomote/redis';
import { TaskPayloadKind } from '@roomote/types';

import { parsePRsFromText } from './extract-pull-requests';

export const SLACK_PR_INACTIVITY_QUEUE_NAME = 'slack-pr-inactivity-check-jobs';
export const SLACK_PR_INACTIVITY_DELAY_MS = 24 * 60 * 60 * 1000;
const SLACK_PR_INACTIVITY_TASK_DEDUP_TTL_SECONDS = 90 * 24 * 60 * 60;

const prCombinedStatusSchema = z
  .enum(['error', 'failure', 'pending', 'success'])
  .nullable();

export const pullRequestActivitySnapshotSchema = z.object({
  headSha: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean(),
  updatedAt: z.string(),
  combinedStatus: prCombinedStatusSchema,
});

export type PullRequestActivitySnapshot = z.infer<
  typeof pullRequestActivitySnapshotSchema
>;

export const slackPrInactivityCheckRequestSchema = z.object({
  cloudJobId: z.number(),
  channel: z.string(),
  threadTs: z.string(),
  repository: z.string(),
  prNumber: z.number().int().positive(),
  baseline: pullRequestActivitySnapshotSchema,
});

export type SlackPrInactivityCheckRequest = z.infer<
  typeof slackPrInactivityCheckRequestSchema
>;

export const enqueueSlackPrInactivityCheckInputSchema = z.object({
  cloudJobId: z.number(),
  completionText: z.string().optional(),
});

export type EnqueueSlackPrInactivityCheckInput = z.infer<
  typeof enqueueSlackPrInactivityCheckInputSchema
>;

type EnqueueSlackPrInactivityCheckResult = {
  enqueued: boolean;
  reason?: string;
  jobId?: string;
};

let slackPrInactivityQueue: Queue<SlackPrInactivityCheckRequest> | null = null;

function getSlackPrInactivityQueue(): Queue<SlackPrInactivityCheckRequest> {
  if (!slackPrInactivityQueue) {
    const redis = getRedis();

    slackPrInactivityQueue = new Queue<SlackPrInactivityCheckRequest>(
      SLACK_PR_INACTIVITY_QUEUE_NAME,
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

  return slackPrInactivityQueue;
}

function getSlackChannelFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const channel =
    typeof record.channel === 'string'
      ? record.channel
      : typeof record.slackChannel === 'string'
        ? record.slackChannel
        : null;

  return channel;
}

async function resolvePullRequestTarget({
  cloudJob,
  completionText,
}: {
  cloudJob: Run;
  completionText?: string;
}): Promise<{ repository: string; prNumber: number } | null> {
  const latestTaskPullRequest = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.taskId, cloudJob.taskId),
      isNotNull(taskPullRequests.repository),
      isNotNull(taskPullRequests.prNumber),
    ),
    orderBy: [desc(taskPullRequests.detectedAt)],
    columns: {
      repository: true,
      prNumber: true,
    },
  });

  if (latestTaskPullRequest?.repository && latestTaskPullRequest.prNumber) {
    return {
      repository: latestTaskPullRequest.repository,
      prNumber: latestTaskPullRequest.prNumber,
    };
  }

  if (!completionText) {
    return null;
  }

  const parsed = parsePRsFromText(completionText);

  if (parsed.length !== 1) {
    return null;
  }

  const candidate = parsed[0]!;

  return { repository: candidate.repository, prNumber: candidate.number };
}

export async function fetchPullRequestSnapshotForCloudJob({
  cloudJob,
  repository,
  prNumber,
}: {
  cloudJob: Run;
  repository: string;
  prNumber: number;
}): Promise<PullRequestActivitySnapshot | null> {
  const [owner, repo] = repository.split('/');

  if (!owner || !repo) {
    return null;
  }

  try {
    const token = await createCloudJobGitHubToken(cloudJob);
    const octokit = getOctokit(token);

    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    let combinedStatus: PullRequestActivitySnapshot['combinedStatus'] = null;

    try {
      const { data: combined } =
        await octokit.rest.repos.getCombinedStatusForRef({
          owner,
          repo,
          ref: pullRequest.head.sha,
        });

      const parsedCombined = prCombinedStatusSchema.safeParse(combined.state);

      if (parsedCombined.success) {
        combinedStatus = parsedCombined.data;
      }
    } catch (error) {
      console.warn(
        `[enqueueSlackPrInactivityCheck] Failed to fetch combined status for ${repository}#${prNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      headSha: pullRequest.head.sha,
      state: pullRequest.state,
      draft: Boolean(pullRequest.draft),
      merged: Boolean(pullRequest.merged),
      updatedAt: pullRequest.updated_at,
      combinedStatus,
    };
  } catch (error) {
    console.warn(
      `[enqueueSlackPrInactivityCheck] Failed to fetch PR snapshot for ${repository}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

export function hasPullRequestMoved({
  baseline,
  current,
}: {
  baseline: PullRequestActivitySnapshot;
  current: PullRequestActivitySnapshot;
}): boolean {
  return (
    baseline.headSha !== current.headSha ||
    baseline.state !== current.state ||
    baseline.draft !== current.draft ||
    baseline.merged !== current.merged ||
    baseline.updatedAt !== current.updatedAt ||
    baseline.combinedStatus !== current.combinedStatus
  );
}

export function isPullRequestTerminal(
  snapshot: PullRequestActivitySnapshot,
): boolean {
  return snapshot.merged || snapshot.state === 'closed';
}

function buildSlackPrInactivityJobId({ taskId }: { taskId: string }): string {
  const encodedTaskId = encodeURIComponent(taskId);

  return `slack-pr-inactivity-${encodedTaskId}`;
}

function buildSlackPrInactivityTaskDedupKey(taskId: string): string {
  return `slack-pr-inactivity:task-scheduled:${encodeURIComponent(taskId)}`;
}

export async function enqueueSlackPrInactivityCheck(
  input: EnqueueSlackPrInactivityCheckInput,
): Promise<EnqueueSlackPrInactivityCheckResult> {
  const parsedInput = enqueueSlackPrInactivityCheckInputSchema.parse(input);

  const cloudJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, parsedInput.cloudJobId),
    with: { task: true },
  });

  if (!cloudJob) {
    return { enqueued: false, reason: 'cloud_job_not_found' };
  }

  if (
    cloudJob.payloadKind !== TaskPayloadKind.SlackAppMention &&
    cloudJob.payloadKind !== TaskPayloadKind.SnapshotResume
  ) {
    return { enqueued: false, reason: 'not_slack_originated' };
  }

  const slackThreadTs = cloudJob.task.slackThreadTs;

  if (!slackThreadTs) {
    return { enqueued: false, reason: 'missing_slack_thread' };
  }

  const channel =
    cloudJob.task.slackChannelId ??
    getSlackChannelFromPayload(cloudJob.payload);

  if (!channel) {
    return { enqueued: false, reason: 'missing_slack_channel' };
  }

  const target = await resolvePullRequestTarget({
    cloudJob,
    completionText: parsedInput.completionText,
  });

  if (!target) {
    return { enqueued: false, reason: 'no_pull_request_detected' };
  }

  const baseline = await fetchPullRequestSnapshotForCloudJob({
    cloudJob,
    repository: target.repository,
    prNumber: target.prNumber,
  });

  if (!baseline) {
    return { enqueued: false, reason: 'baseline_fetch_failed' };
  }

  if (isPullRequestTerminal(baseline)) {
    return { enqueued: false, reason: 'pr_already_terminal' };
  }

  const queue = getSlackPrInactivityQueue();
  const redis = getRedis();
  const dedupeKey = buildSlackPrInactivityTaskDedupKey(cloudJob.taskId);
  const jobId = buildSlackPrInactivityJobId({
    taskId: cloudJob.taskId,
  });
  const claim = await redis.set(
    dedupeKey,
    jobId,
    'EX',
    SLACK_PR_INACTIVITY_TASK_DEDUP_TTL_SECONDS,
    'NX',
  );

  if (claim !== 'OK') {
    return { enqueued: false, reason: 'already_scheduled_for_task', jobId };
  }

  const existingJob = await queue.getJob(jobId);

  if (existingJob) {
    return { enqueued: false, reason: 'already_scheduled_for_task', jobId };
  }

  try {
    await queue.add(
      'check-pr-activity',
      {
        cloudJobId: cloudJob.id,
        channel,
        threadTs: slackThreadTs,
        repository: target.repository,
        prNumber: target.prNumber,
        baseline,
      },
      {
        jobId,
        delay: SLACK_PR_INACTIVITY_DELAY_MS,
      },
    );
  } catch (error) {
    // Allow retries on later completion events if queue insertion failed.
    await redis.del(dedupeKey);
    throw error;
  }

  return { enqueued: true, jobId };
}
