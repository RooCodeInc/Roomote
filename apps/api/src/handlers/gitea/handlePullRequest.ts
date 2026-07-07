import pMap from 'p-map';

import {
  type CloudTaskPayload,
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
  CloudTaskType,
  CloudAgentType,
} from '@roomote/types';
import {
  db,
  repositories,
  and,
  eq,
  findActiveGitHubPrReviewTask,
} from '@roomote/db/server';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { updateTaskPrStatus } from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { notifySlackPrMerge } from '../github/notifySlackPrMerge';
import { notifyTeamsPrMerge } from '../github/notifyTeamsPrMerge';
import { notifyTelegramAndLinearPrMerge } from '../github/notifyTelegramAndLinearPrMerge';
import {
  getGiteaAutomationTargets,
  getGiteaUsername,
} from './getGiteaAutomationTargets';
import type { GiteaPullRequestWebhook } from './types';

function getPullRequestHeadSha(payload: GiteaPullRequestWebhook): string {
  return payload.pull_request.head?.sha ?? payload.commit_id ?? '';
}

function getPullRequestUrl(payload: GiteaPullRequestWebhook): string {
  return (
    payload.pull_request.html_url ??
    payload.pull_request.url ??
    `${payload.repository.html_url ?? ''}/pulls/${payload.number}`
  );
}

function getReviewTaskType(
  payload: GiteaPullRequestWebhook,
): CloudTaskType.GithubPrReview | CloudTaskType.GithubPrReviewSync | null {
  const action = payload.action;

  if (action === 'opened' || action === 'reopened') {
    return CloudTaskType.GithubPrReview;
  }

  if (action === 'synchronized') {
    return CloudTaskType.GithubPrReviewSync;
  }

  return null;
}

async function notifyMergedPullRequestThreads(
  payload: GiteaPullRequestWebhook,
  repoFullName: string,
): Promise<void> {
  const repositoryRow = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'gitea'),
      eq(repositories.fullName, repoFullName),
      eq(repositories.isActive, true),
    ),
    columns: { id: true },
  });

  if (!repositoryRow) {
    return;
  }

  const notificationParams = {
    sourceControlProvider: 'gitea' as const,
    repository: repoFullName,
    prNumber: payload.number,
    prTitle: payload.pull_request.title,
    prUrl: getPullRequestUrl(payload),
    mergedBy: getGiteaUsername(payload.sender) ?? 'someone on Gitea',
  };

  notifySlackPrMerge(notificationParams).catch((error) => {
    console.error(
      `[handleGiteaPullRequest] Failed to notify Slack for PR #${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  notifyTeamsPrMerge(notificationParams).catch((error) => {
    console.error(
      `[handleGiteaPullRequest] Failed to notify Teams for PR #${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  notifyTelegramAndLinearPrMerge({
    ...notificationParams,
    sourceControlProvider: 'gitea',
  }).catch((error) => {
    console.error(
      `[handleGiteaPullRequest] Failed to notify Telegram/Linear for PR #${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

export async function handleGiteaPullRequest(
  payload: GiteaPullRequestWebhook,
): Promise<WebhookResponse> {
  const repoFullName = payload.repository.full_name;
  const pullRequest = payload.pull_request;

  if (payload.action === 'closed') {
    await updateTaskPrStatus(
      'gitea',
      repoFullName,
      payload.number,
      pullRequest.merged ? 'merged' : 'closed',
    );

    if (pullRequest.merged) {
      await notifyMergedPullRequestThreads(payload, repoFullName);
    }

    return { status: 'ok' };
  }

  const taskType = getReviewTaskType(payload);

  if (!taskType) {
    return {
      status: 'ok',
      message: `unsupported_pull_request_action:${payload.action}`,
    };
  }

  const result = await getGiteaAutomationTargets({
    type: CloudAgentType.PrReviewer,
    payload,
  });

  if (result.status === 'error') {
    return result;
  }

  const targets = result.targets.filter((target) => {
    const settings = target.settings as PrReviewerSettings | null;
    const reviewOnCommit =
      settings?.reviewOnCommit ?? DEFAULT_PR_REVIEWER_SETTINGS.reviewOnCommit;
    const reviewDraftPrs =
      settings?.reviewDraftPrs ?? DEFAULT_PR_REVIEWER_SETTINGS.reviewDraftPrs;

    if (!reviewOnCommit) {
      return false;
    }

    return !pullRequest.draft || reviewDraftPrs;
  });

  if (targets.length === 0) {
    return { status: 'ok', message: 'No Gitea PR reviewer targets found.' };
  }

  const headSha = getPullRequestHeadSha(payload);

  if (taskType === CloudTaskType.GithubPrReviewSync && headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber: payload.number,
      headSha,
      sourceControlProvider: 'gitea',
    });

    if (activeReview?.taskId) {
      console.log(
        `[handleGiteaPullRequest] ${repoFullName}#${payload.number} -> skip_already_reviewed_head (task: ${activeReview.taskId})`,
      );

      return {
        status: 'ok',
        message: 'Gitea PR head SHA already has an active review job.',
      };
    }
  }

  const enqueued = await pMap(targets, async (target) =>
    enqueueCloudTask(
      {
        userId: target.userId,
        attributionOverride: {
          kind: 'automatic',
          sourceKind: 'gitea',
        },
        type: taskType,
        payload: {
          repo: repoFullName,
          sourceControlProvider: 'gitea',
          prNumber: payload.number,
          prTitle: pullRequest.title,
          prUrl: getPullRequestUrl(payload),
          headSha,
          branchName: pullRequest.head?.ref,
          ...(pullRequest.head?.ref ? { branch: pullRequest.head.ref } : {}),
          ...(headSha ? { sha: headSha } : {}),
          targetBranch: pullRequest.base?.ref,
        } satisfies CloudTaskPayload<typeof taskType>,
      },
      {
        launchClass: 'automation',
      },
    ),
  );

  return {
    status: 'ok',
    metadata: {
      ids: enqueued.flatMap((item) => (item ? [item.id] : [])),
    },
  };
}
