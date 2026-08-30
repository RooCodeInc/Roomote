import { Queue } from 'bullmq';

import {
  enrichPullRequestFacts,
  syncGitHubPullRequestFactsForAllOrgs,
  syncSourceControlPullRequestFacts,
} from '@roomote/sdk/server';

import { getRedis } from '../redis';
import { ScheduledJobName } from '../types';

const LOG_PREFIX = '[pullRequestAnalyticsSync]';

let followUpQueue: Queue | null = null;

/** Test seam: drop the memoized queue so a fresh connection is created. */
export function resetPullRequestAnalyticsFollowUpQueueForTests(): void {
  followUpQueue = null;
}

/**
 * The PR-fact → Brain sync lives in BrainCollectors, which reads the local
 * `pull_request_facts` table this job populates. A one-off collectors run
 * kicked alongside this job (the memory-enable backfill) can race it and see
 * an empty table, deferring initial PR ingestion to the next 15-minute tick —
 * so a kicked run chains a follow-up collectors run once the table is
 * populated. Fire-and-forget: the schedule is the safety net.
 */
async function enqueueBrainCollectorsFollowUp(): Promise<void> {
  try {
    if (!followUpQueue) {
      followUpQueue = new Queue('scheduled-jobs', {
        connection: getRedis(),
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: { age: 3600, count: 10 },
          removeOnFail: { age: 3600 },
        },
      });
    }

    const minuteBucket = Math.floor(Date.now() / 60_000);
    await followUpQueue.add(
      ScheduledJobName.BrainCollectors,
      { reason: 'pull-request-analytics-sync' },
      { jobId: `brain-collectors-post-pr-sync-${minuteBucket}` },
    );
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} failed to enqueue BrainCollectors follow-up:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function pullRequestAnalyticsSyncJob(
  opts: { manualTrigger?: boolean; chainBrainCollectors?: boolean } = {},
) {
  console.log(
    `${LOG_PREFIX} Starting sync${opts.manualTrigger ? ' (manual)' : ''}`,
  );

  // GitHub facts come from the analytics sync; the provider-neutral sync
  // covers merged PRs on GitLab/Gitea/Azure DevOps/Bitbucket repositories.
  const results = [
    ...(await syncGitHubPullRequestFactsForAllOrgs()),
    await syncSourceControlPullRequestFacts(),
  ];
  const totals = results.reduce(
    (acc, result) => ({
      eligibleRepositories:
        acc.eligibleRepositories + result.eligibleRepositories,
      processedRepositories:
        acc.processedRepositories + result.processedRepositories,
      failedRepositories: acc.failedRepositories + result.failedRepositories,
      cooledDownRepositories:
        acc.cooledDownRepositories + result.cooledDownRepositories,
    }),
    {
      eligibleRepositories: 0,
      processedRepositories: 0,
      failedRepositories: 0,
      cooledDownRepositories: 0,
    },
  );

  console.log(
    `${LOG_PREFIX} Completed: ${totals.processedRepositories}/${totals.eligibleRepositories} processed, ${totals.failedRepositories} failed, ${totals.cooledDownRepositories} cooled down`,
  );

  // Before the enrichment pass: the facts rows already exist, and enrichment
  // only adds detail the collector's watermark re-reads later.
  if (opts.chainBrainCollectors) {
    await enqueueBrainCollectorsFollowUp();
  }

  // Files touched and reviews need per-PR requests the list sync above
  // does not make; a bounded batch per pass keeps that traffic predictable.
  try {
    await enrichPullRequestFacts();
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} enrichment pass failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
