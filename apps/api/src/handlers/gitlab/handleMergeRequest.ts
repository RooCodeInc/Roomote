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
import { getGitLabAutomationTargets } from './getGitLabAutomationTargets';
import type { GitLabMergeRequestWebhook } from './types';

function getMergeRequestHeadSha(payload: GitLabMergeRequestWebhook): string {
  return payload.object_attributes.last_commit?.id ?? '';
}

function getReviewTaskType(
  payload: GitLabMergeRequestWebhook,
): CloudTaskType.GithubPrReview | CloudTaskType.GithubPrReviewSync | null {
  const action = payload.object_attributes.action;

  if (action === 'open' || action === 'reopen') {
    return CloudTaskType.GithubPrReview;
  }

  if (action === 'update' && payload.object_attributes.oldrev) {
    return CloudTaskType.GithubPrReviewSync;
  }

  return null;
}

/**
 * Notifies Slack, Teams, Telegram, and Linear threads/sessions linked to the
 * MR after a merge. GitLab has no installation gate, so verify the repository
 * is an active synced GitLab row before notifying (fire-and-forget, mirroring
 * the GitHub merge handler).
 */
async function notifyMergedMergeRequestThreads(
  payload: GitLabMergeRequestWebhook,
  repoFullName: string,
): Promise<void> {
  const repositoryRow = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'gitlab'),
      eq(repositories.fullName, repoFullName),
      eq(repositories.isActive, true),
    ),
    columns: { id: true },
  });

  if (!repositoryRow) {
    return;
  }

  const notificationParams = {
    sourceControlProvider: 'gitlab' as const,
    repository: repoFullName,
    prNumber: payload.object_attributes.iid,
    prTitle: payload.object_attributes.title,
    prUrl: payload.object_attributes.url,
    mergedBy:
      payload.user?.username ?? payload.user?.name ?? 'someone on GitLab',
  };

  notifySlackPrMerge(notificationParams).catch((error) => {
    console.error(
      `[handleGitLabMergeRequest] Failed to notify Slack for MR !${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  notifyTeamsPrMerge(notificationParams).catch((error) => {
    console.error(
      `[handleGitLabMergeRequest] Failed to notify Teams for MR !${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  notifyTelegramAndLinearPrMerge({
    ...notificationParams,
    sourceControlProvider: 'gitlab',
  }).catch((error) => {
    console.error(
      `[handleGitLabMergeRequest] Failed to notify Telegram/Linear for MR !${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

export async function handleGitLabMergeRequest(
  payload: GitLabMergeRequestWebhook,
): Promise<WebhookResponse> {
  const { object_attributes: mergeRequest } = payload;
  const repoFullName = payload.project.path_with_namespace;

  if (!repoFullName) {
    return { status: 'error', message: 'missing_project_path_with_namespace' };
  }

  if (mergeRequest.action === 'close' || mergeRequest.action === 'merge') {
    await updateTaskPrStatus(
      'gitlab',
      repoFullName,
      mergeRequest.iid,
      mergeRequest.action === 'merge' ? 'merged' : 'closed',
    );

    if (mergeRequest.action === 'merge') {
      await notifyMergedMergeRequestThreads(payload, repoFullName);
    }

    return { status: 'ok' };
  }

  const taskType = getReviewTaskType(payload);

  if (!taskType) {
    return {
      status: 'ok',
      message: `unsupported_merge_request_action:${mergeRequest.action}`,
    };
  }

  const result = await getGitLabAutomationTargets({
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

    return !mergeRequest.draft || reviewDraftPrs;
  });

  if (targets.length === 0) {
    return { status: 'ok', message: 'No GitLab MR reviewer targets found.' };
  }

  const headSha = getMergeRequestHeadSha(payload);

  if (taskType === CloudTaskType.GithubPrReviewSync && headSha) {
    const activeReview = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber: mergeRequest.iid,
      headSha,
      sourceControlProvider: 'gitlab',
    });

    if (activeReview?.taskId) {
      console.log(
        `[handleGitLabMergeRequest] ${repoFullName}!${mergeRequest.iid} -> skip_already_reviewed_head (task: ${activeReview.taskId})`,
      );

      return {
        status: 'ok',
        message: 'GitLab MR head SHA already has an active review job.',
      };
    }
  }

  const enqueued = await pMap(targets, async (target) =>
    enqueueCloudTask(
      {
        userId: target.userId,
        attributionOverride: {
          kind: 'automatic',
          sourceKind: 'gitlab',
        },
        type: taskType,
        payload: {
          repo: repoFullName,
          sourceControlProvider: 'gitlab',
          prNumber: mergeRequest.iid,
          prTitle: mergeRequest.title,
          prUrl: mergeRequest.url,
          headSha,
          branchName: mergeRequest.source_branch,
          ...(mergeRequest.source_branch
            ? { branch: mergeRequest.source_branch }
            : {}),
          ...(headSha ? { sha: headSha } : {}),
          targetBranch: mergeRequest.target_branch,
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
