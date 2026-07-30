import pMap from 'p-map';

import {
  type TaskPayload,
  DEFAULT_PR_REVIEW_SETTINGS,
  type PrReviewSettings,
  TaskPayloadKind,
  RunStatus,
  exitedRunStatuses,
} from '@roomote/types';
import {
  db,
  taskPullRequests,
  taskRuns,
  tasks,
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  sql,
} from '@roomote/db/server';
import { enqueueTask } from '@roomote/cloud-agents/server';
import { acquireRedisLock } from '@roomote/redis';

import type { WebhookResponse } from '../../types';
import { toHostFromUrl } from '../utils';

import type { WebhookPullRequestSynchronize } from './types';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { getBackgroundGithubTaskProperties } from './backgroundGithubTaskProperties';
import { getReviewTaskRelayPayload } from './reviewTaskRelayPayload';

async function findActiveReviewRun(repository: string, prNumber: number) {
  const [activeRun] = await db
    .select({ id: taskRuns.id })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repository),
        eq(taskPullRequests.prNumber, prNumber),
        not(
          inArray(taskRuns.status, exitedRunStatuses as unknown as RunStatus[]),
        ),
        isNull(taskRuns.canceledAt),
      ),
    )
    .limit(1);

  return activeRun;
}

async function acquirePrReviewLaunchLock(repository: string, prNumber: number) {
  const key = `pr-review-synchronize:${repository}:${prNumber}`;

  for (let attempt = 0; attempt < 100; attempt++) {
    const release = await acquireRedisLock(key, { ttlSeconds: 30 });

    if (release) {
      return release;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
}

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
    workflow: 'pr_review',
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
    const settings = target.settings as PrReviewSettings | null;
    const reviewOnCommit =
      settings?.reviewOnCommit ?? DEFAULT_PR_REVIEW_SETTINGS.reviewOnCommit;
    const reviewDraftPrs =
      settings?.reviewDraftPrs ?? DEFAULT_PR_REVIEW_SETTINGS.reviewDraftPrs;

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
    const releaseLaunchLock = await acquirePrReviewLaunchLock(
      repository.full_name,
      pr.number,
    );

    if (!releaseLaunchLock) {
      throw new Error(
        `Timed out serializing PR review launch for ${repository.full_name}#${pr.number}`,
      );
    }

    try {
      const activeReviewRun = await findActiveReviewRun(
        repository.full_name,
        pr.number,
      );

      if (activeReviewRun) {
        console.log(
          `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> skip_active_review (target: ${currentTarget.id})`,
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
            sql`${taskRuns.status} != ${RunStatus.Failed}`,
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

      return enqueueTask({
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
          } satisfies TaskPayload<
            | typeof TaskPayloadKind.GithubPrReviewSync
            | typeof TaskPayloadKind.GithubPrReview
          >,
        },
        initiator: {
          kind: 'automation',
          key: 'review_code',
          actor: {
            externalId: String(sender.id),
            displayName: sender.login,
          },
        },
        workflow: 'pr_review',
        surface: 'github',
        trigger: 'webhook',
        prLinkage: {
          provider: 'github',
          host: target.repo.host ?? toHostFromUrl(pr.html_url) ?? 'github.com',
          repositoryId: target.repo.id,
          repository: repository.full_name,
          prNumber: pr.number,
          prUrl: pr.html_url,
          prTitle: pr.title,
          prSha: pr.head.sha,
          prBaseRef: pr.base?.ref ?? null,
          prBaseSha: pr.base?.sha ?? null,
        },
      });
    } finally {
      await releaseLaunchLock();
    }
  });

  const ids = enqueued.flatMap((job) => (job ? [job.id] : []));

  if (ids.length === 0) {
    return {
      status: 'ok',
      message: 'A PR review is already active.',
    };
  }

  return { status: 'ok', metadata: { ids } };
}
