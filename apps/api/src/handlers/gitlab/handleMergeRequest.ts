import pMap from 'p-map';

import {
  type TaskPayload,
  DEFAULT_PR_REVIEW_SETTINGS,
  type PrReviewSettings,
  TaskPayloadKind,
} from '@roomote/types';
import {
  db,
  repositories,
  and,
  eq,
  findActiveGitHubPrReviewTask,
} from '@roomote/db/server';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  recordPrStatusChangeInTaskHistory,
  updateTaskPrStatus,
} from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { scheduleNotifyPullRequestTerminalStatus } from '../github/notifyPullRequestTerminalStatus';
import { scheduleSourceControlPullRequestFactSync } from '../pull-request-fact-sync';
import { getGitLabAutomationTargets } from './getGitLabAutomationTargets';
import type { GitLabMergeRequestWebhook } from './types';

function getMergeRequestHeadSha(payload: GitLabMergeRequestWebhook): string {
  return payload.object_attributes.last_commit?.id ?? '';
}

function getReviewTaskType(
  payload: GitLabMergeRequestWebhook,
):
  | typeof TaskPayloadKind.GithubPrReview
  | typeof TaskPayloadKind.GithubPrReviewSync
  | null {
  const action = payload.object_attributes.action;

  if (action === 'open' || action === 'reopen') {
    return TaskPayloadKind.GithubPrReview;
  }

  if (action === 'update' && payload.object_attributes.oldrev) {
    return TaskPayloadKind.GithubPrReviewSync;
  }

  return null;
}

/**
 * Notifies Slack, Teams, Telegram, and Linear threads/sessions linked to the
 * MR after it becomes terminal (merged or closed). GitLab has no installation
 * gate, so verify the repository is an active synced GitLab row before
 * notifying (fire-and-forget, mirroring the GitHub status handler).
 */
async function notifyTerminalMergeRequestThreads(
  payload: GitLabMergeRequestWebhook,
  repoFullName: string,
  status: 'merged' | 'closed',
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

  scheduleNotifyPullRequestTerminalStatus(
    {
      sourceControlProvider: 'gitlab',
      repository: repoFullName,
      prNumber: payload.object_attributes.iid,
      prTitle: payload.object_attributes.title,
      prUrl: payload.object_attributes.url,
      status,
      actorLogin:
        payload.user?.username ?? payload.user?.name ?? 'someone on GitLab',
    },
    `MR !${payload.object_attributes.iid}`,
  );
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
    const status =
      mergeRequest.action === 'merge'
        ? ('merged' as const)
        : ('closed' as const);

    await updateTaskPrStatus('gitlab', repoFullName, mergeRequest.iid, status);

    scheduleSourceControlPullRequestFactSync({
      provider: 'gitlab',
      repositoryFullName: repoFullName,
      pullRequest: {
        number: mergeRequest.iid,
        externalId: mergeRequest.id ?? null,
        title: mergeRequest.title,
        url: mergeRequest.url,
        // The merge-request webhook carries the acting user, not the MR
        // author; the scheduled sync backfills authorLogin.
        authorLogin: null,
        state: status,
        createdAt: mergeRequest.created_at ?? null,
        updatedAt: mergeRequest.updated_at ?? null,
      },
    });

    await Promise.resolve(
      recordPrStatusChangeInTaskHistory({
        sourceControlProvider: 'gitlab',
        repository: repoFullName,
        prNumber: mergeRequest.iid,
        prTitle: mergeRequest.title,
        prUrl: mergeRequest.url,
        status,
        actorLogin:
          payload.user?.username ?? payload.user?.name ?? 'someone on GitLab',
      }),
    ).catch((error) => {
      console.warn(
        `[handleGitLabMergeRequest] Failed to record PR status in task history for ${repoFullName}!${mergeRequest.iid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    if (mergeRequest.action === 'merge' || mergeRequest.action === 'close') {
      await notifyTerminalMergeRequestThreads(payload, repoFullName, status);
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
    workflow: 'pr_review',
    payload,
  });

  if (result.status === 'error') {
    return result;
  }

  const targets = result.targets.filter((target) => {
    const settings = target.settings as PrReviewSettings | null;
    const reviewOnCommit =
      settings?.reviewOnCommit ?? DEFAULT_PR_REVIEW_SETTINGS.reviewOnCommit;
    const reviewDraftPrs =
      settings?.reviewDraftPrs ?? DEFAULT_PR_REVIEW_SETTINGS.reviewDraftPrs;

    if (!reviewOnCommit) {
      return false;
    }

    return !mergeRequest.draft || reviewDraftPrs;
  });

  if (targets.length === 0) {
    return { status: 'ok', message: 'No GitLab MR reviewer targets found.' };
  }

  const headSha = getMergeRequestHeadSha(payload);

  if (taskType === TaskPayloadKind.GithubPrReviewSync && headSha) {
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

  const mrAuthorId =
    payload.user?.id != null ? String(payload.user.id) : payload.user?.username;
  const mrAuthorName = payload.user?.name ?? payload.user?.username;

  const enqueued = await pMap(targets, async (_target) =>
    enqueueTask(
      {
        task: {
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
          } satisfies TaskPayload<typeof taskType>,
        },
        initiator: {
          kind: 'automation',
          key: 'review_code',
          ...(mrAuthorId
            ? {
                actor: {
                  externalId: mrAuthorId,
                  displayName: mrAuthorName,
                },
              }
            : {}),
        },
        workflow: 'pr_review',
        surface: 'gitlab',
        trigger: 'webhook',
        prLinkage: {
          provider: 'gitlab',
          repository: repoFullName,
          prNumber: mergeRequest.iid,
          prUrl: mergeRequest.url,
          prTitle: mergeRequest.title,
          prSha: headSha || null,
          prBaseRef: mergeRequest.target_branch ?? null,
        },
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
