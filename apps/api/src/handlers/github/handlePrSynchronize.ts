import pMap from 'p-map';

import {
  type CloudTaskPayload,
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
  CloudTaskType,
  CloudAgentType,
  CloudTaskStatus,
} from '@roomote/types';
import {
  db,
  cloudJobs,
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  desc,
  sql,
} from '@roomote/db/server';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';

import type { WebhookResponse } from '../../types';

import type { WebhookPullRequestSynchronize } from './types';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { getBackgroundGithubTaskProperties } from './backgroundGithubTaskProperties';
import { getReviewTaskRelayPayload } from './reviewTaskRelayPayload';

export async function handlePrSynchronize({
  installation,
  repository,
  pull_request: pr,
  sender,
}: WebhookPullRequestSynchronize): Promise<WebhookResponse> {
  if (pr.locked) {
    return { status: 'error', message: 'PR is locked' };
  }

  const result = await getGitHubAutomationTargets({
    type: CloudAgentType.PrReviewer,
    installation,
    repository,
    sender,
    author: pr.user?.login?.toLowerCase(),
  });

  if (result.status === 'error') {
    return result;
  }

  const { targets: allTargets } = result;

  const targets = allTargets.filter((target) => {
    const settings = target.settings as PrReviewerSettings | null;
    const reviewOnCommit =
      settings?.reviewOnCommit ?? DEFAULT_PR_REVIEWER_SETTINGS.reviewOnCommit;
    const reviewDraftPrs =
      settings?.reviewDraftPrs ?? DEFAULT_PR_REVIEWER_SETTINGS.reviewDraftPrs;

    if (!reviewOnCommit) {
      return false;
    }

    return !pr.draft || reviewDraftPrs;
  });

  const target = targets[0];

  if (!target) {
    return { status: 'ok', message: 'No PR reviewer targets found.' };
  }

  const enqueued = await pMap(targets, async (currentTarget) => {
    const currentHeadReviewJob = await db.query.cloudJobs.findFirst({
      where: and(
        inArray(cloudJobs.type, [
          CloudTaskType.GithubPrReview,
          CloudTaskType.GithubPrReviewSync,
        ]),
        eq(cloudJobs.prRepo, repository.full_name),
        eq(cloudJobs.prNumber, pr.number),
        eq(cloudJobs.prSha, pr.head.sha),
        sql`${cloudJobs.status} != ${CloudTaskStatus.Failed}`,
        isNotNull(cloudJobs.startedAt),
        isNotNull(cloudJobs.prSha),
        isNull(cloudJobs.canceledAt),
      ),
      orderBy: [desc(cloudJobs.createdAt)],
    });

    if (currentHeadReviewJob) {
      console.log(
        `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> skip_already_reviewed_head (target: ${currentTarget.id})`,
      );

      return null;
    }

    const siblingCloudJob = await db.query.cloudJobs.findFirst({
      where: and(
        inArray(cloudJobs.type, [
          CloudTaskType.GithubPrReview,
          CloudTaskType.GithubPrReviewSync,
        ]),
        eq(cloudJobs.prRepo, repository.full_name),
        eq(cloudJobs.prNumber, pr.number),
        sql`${cloudJobs.status} != ${CloudTaskStatus.Failed}`,
        sql`${cloudJobs.prSha} != ${pr.head.sha}`,
        isNotNull(cloudJobs.startedAt),
        isNotNull(cloudJobs.prSha),
        isNull(cloudJobs.canceledAt),
      ),
      orderBy: [desc(cloudJobs.createdAt)],
    });

    const shouldRunSyncReview = !!siblingCloudJob?.prSha;

    console.log(
      `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> ${
        shouldRunSyncReview ? 'sync_review' : 'initial_review'
      } (target: ${currentTarget.id})`,
    );

    const relayPayload = await getReviewTaskRelayPayload({
      repository: repository.full_name,
      prNumber: pr.number,
      branchName: pr.head.ref,
      prBody: pr.body ?? null,
      reviewerSettings: currentTarget.settings,
    });

    return enqueueCloudTask({
      type: shouldRunSyncReview
        ? CloudTaskType.GithubPrReviewSync
        : CloudTaskType.GithubPrReview,
      payload: shouldRunSyncReview
        ? ({
            repo: repository.full_name,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            headSha: pr.head.sha,
            branchName: pr.head.ref,
            ...relayPayload,
          } satisfies CloudTaskPayload<CloudTaskType.GithubPrReviewSync>)
        : ({
            repo: repository.full_name,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            headSha: pr.head.sha,
            branchName: pr.head.ref,
            ...relayPayload,
          } satisfies CloudTaskPayload<CloudTaskType.GithubPrReview>),
      ...getBackgroundGithubTaskProperties(currentTarget.properties),
    });
  });

  const ids = enqueued.flatMap((job) => (job ? [job.id] : []));

  if (ids.length === 0) {
    return {
      status: 'ok',
      message: 'PR head SHA already matches the latest reviewed SHA.',
    };
  }

  return { status: 'ok', metadata: { ids } };
}
