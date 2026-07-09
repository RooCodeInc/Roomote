import pMap from 'p-map';

import {
  type CloudTaskPayload,
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
  TaskPayloadKind,
  CloudAgentType,
  CloudTaskStatus,
} from '@roomote/types';
import {
  db,
  taskPullRequests,
  taskRuns,
  tasks,
  and,
  eq,
  isNotNull,
  isNull,
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
    // PR association lives on task_pull_requests (inserted at enqueue for
    // pr_review launches), so head-SHA dedup is a tasks JOIN
    // task_pull_requests (+ task_runs for run status).
    const [currentHeadReviewRun] = await db
      .select({ id: taskRuns.id })
      .from(tasks)
      .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
      .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
      .where(
        and(
          eq(tasks.workflow, 'pr_review'),
          eq(taskPullRequests.sourceControlProvider, 'github'),
          eq(taskPullRequests.repository, repository.full_name),
          eq(taskPullRequests.prNumber, pr.number),
          eq(taskPullRequests.prSha, pr.head.sha),
          sql`${taskRuns.status} != ${CloudTaskStatus.Failed}`,
          isNotNull(taskRuns.startedAt),
          isNull(taskRuns.canceledAt),
        ),
      )
      .limit(1);

    if (currentHeadReviewRun) {
      console.log(
        `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> skip_already_reviewed_head (target: ${currentTarget.id})`,
      );

      return null;
    }

    const [siblingReviewRun] = await db
      .select({ id: taskRuns.id })
      .from(tasks)
      .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
      .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
      .where(
        and(
          eq(tasks.workflow, 'pr_review'),
          eq(taskPullRequests.sourceControlProvider, 'github'),
          eq(taskPullRequests.repository, repository.full_name),
          eq(taskPullRequests.prNumber, pr.number),
          sql`${taskRuns.status} != ${CloudTaskStatus.Failed}`,
          sql`${taskPullRequests.prSha} != ${pr.head.sha}`,
          isNotNull(taskPullRequests.prSha),
          isNotNull(taskRuns.startedAt),
          isNull(taskRuns.canceledAt),
        ),
      )
      .limit(1);

    const shouldRunSyncReview = !!siblingReviewRun;

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
      task: {
        type: shouldRunSyncReview
          ? TaskPayloadKind.GithubPrReviewSync
          : TaskPayloadKind.GithubPrReview,
        ...getBackgroundGithubTaskProperties(currentTarget.properties),
        payload: {
          repo: repository.full_name,
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.html_url,
          headSha: pr.head.sha,
          branchName: pr.head.ref,
          ...relayPayload,
        } satisfies CloudTaskPayload<
          | typeof TaskPayloadKind.GithubPrReviewSync
          | typeof TaskPayloadKind.GithubPrReview
        >,
      },
      initiator: {
        kind: 'automation',
        key: 'review_code',
        actor: { externalId: String(sender.id), displayName: sender.login },
      },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: {
        provider: 'github',
        repository: repository.full_name,
        prNumber: pr.number,
        prUrl: pr.html_url,
        prTitle: pr.title,
        prSha: pr.head.sha,
        prBaseRef: pr.base?.ref ?? null,
        prBaseSha: pr.base?.sha ?? null,
      },
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
