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
  repositories,
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
import { updateTaskPrStatus } from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { notifySlackPrMerge } from '../github/notifySlackPrMerge';
import { notifyTeamsPrMerge } from '../github/notifyTeamsPrMerge';
import { notifyTelegramAndLinearPrMerge } from '../github/notifyTelegramAndLinearPrMerge';
import {
  getAdoAutomationTargets,
  getAdoIdentityName,
} from './getAdoAutomationTargets';
import {
  getAdoPullRequestHeadSha,
  getAdoPullRequestRepositoryFullName,
  getAdoPullRequestUrl,
  stripAdoGitRefPrefix,
} from './pullRequestMetadata';
import type { AdoPullRequestWebhook } from './types';

export type AdoUpdatedNotificationType =
  | 'PushNotification'
  | 'StatusUpdateNotification';

type AdoPullRequestWebhookContext = {
  updatedNotificationType?: AdoUpdatedNotificationType;
};

function getReviewTaskType(
  payload: AdoPullRequestWebhook,
  context: AdoPullRequestWebhookContext,
):
  | typeof TaskPayloadKind.GithubPrReview
  | typeof TaskPayloadKind.GithubPrReviewSync
  | null {
  if (payload.resource.status && payload.resource.status !== 'active') {
    return null;
  }

  if (payload.eventType === 'git.pullrequest.created') {
    return TaskPayloadKind.GithubPrReview;
  }

  if (payload.eventType === 'git.pullrequest.updated') {
    if (context.updatedNotificationType === 'StatusUpdateNotification') {
      return null;
    }

    return TaskPayloadKind.GithubPrReviewSync;
  }

  return null;
}

async function notifyMergedPullRequestThreads(
  payload: AdoPullRequestWebhook,
  repoFullName: string,
): Promise<void> {
  const repositoryRow = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'ado'),
      eq(repositories.fullName, repoFullName),
      eq(repositories.isActive, true),
    ),
    columns: { id: true },
  });

  if (!repositoryRow) {
    return;
  }

  const notificationParams = {
    sourceControlProvider: 'ado' as const,
    repository: repoFullName,
    prNumber: payload.resource.pullRequestId,
    prTitle: payload.resource.title,
    prUrl: getAdoPullRequestUrl({
      resourceContainers: payload.resourceContainers,
      pullRequest: payload.resource,
      repositoryFullName: repoFullName,
    }),
    mergedBy:
      getAdoIdentityName(payload.resource.closedBy) ??
      'someone in Azure DevOps',
  };

  notifySlackPrMerge(notificationParams).catch((error) => {
    console.error(
      `[handleAdoPullRequest] Failed to notify Slack for PR #${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  notifyTeamsPrMerge(notificationParams).catch((error) => {
    console.error(
      `[handleAdoPullRequest] Failed to notify Teams for PR #${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  notifyTelegramAndLinearPrMerge({
    ...notificationParams,
    sourceControlProvider: 'ado',
  }).catch((error) => {
    console.error(
      `[handleAdoPullRequest] Failed to notify Telegram/Linear for PR #${notificationParams.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

async function getAdoSyncReviewDecision({
  repoFullName,
  prNumber,
  headSha,
  context,
}: {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  context: AdoPullRequestWebhookContext;
}): Promise<{ shouldEnqueue: boolean; message?: string }> {
  if (!headSha) {
    return { shouldEnqueue: true };
  }

  // PR association lives on task_pull_requests (inserted at enqueue for
  // pr_review launches): head-SHA dedup is tasks JOIN task_pull_requests
  // (+ task_runs for run status).
  const [currentHeadReviewRun] = await db
    .select({ id: taskRuns.id })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.sourceControlProvider, 'ado'),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
        eq(taskPullRequests.prSha, headSha),
        sql`${taskRuns.status} != ${CloudTaskStatus.Failed}`,
        isNull(taskRuns.canceledAt),
      ),
    )
    .limit(1);

  if (currentHeadReviewRun) {
    return {
      shouldEnqueue: false,
      message: 'Azure DevOps PR head SHA already has a review job.',
    };
  }

  if (context.updatedNotificationType === 'PushNotification') {
    return { shouldEnqueue: true };
  }

  const [priorReviewRun] = await db
    .select({ id: taskRuns.id })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.sourceControlProvider, 'ado'),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
        sql`${taskRuns.status} != ${CloudTaskStatus.Failed}`,
        sql`${taskPullRequests.prSha} != ${headSha}`,
        isNotNull(taskPullRequests.prSha),
        isNull(taskRuns.canceledAt),
      ),
    )
    .limit(1);

  if (!priorReviewRun) {
    return {
      shouldEnqueue: false,
      message: 'No prior Azure DevOps PR review found for sync event.',
    };
  }

  return { shouldEnqueue: true };
}

export async function handleAdoPullRequest(
  payload: AdoPullRequestWebhook,
  context: AdoPullRequestWebhookContext = {},
): Promise<WebhookResponse> {
  const pullRequest = payload.resource;
  const repoFullName = getAdoPullRequestRepositoryFullName({
    resourceContainers: payload.resourceContainers,
    pullRequest,
  });

  if (pullRequest.status === 'abandoned') {
    if (payload.eventType !== 'git.pullrequest.updated') {
      return {
        status: 'ok',
        message: `unsupported_ado_pull_request_event:${payload.eventType}`,
      };
    }

    await updateTaskPrStatus(
      'ado',
      repoFullName,
      pullRequest.pullRequestId,
      'closed',
    );

    return { status: 'ok' };
  }

  if (pullRequest.status === 'completed') {
    if (payload.eventType !== 'git.pullrequest.updated') {
      return {
        status: 'ok',
        message: `unsupported_ado_pull_request_event:${payload.eventType}`,
      };
    }

    await updateTaskPrStatus(
      'ado',
      repoFullName,
      pullRequest.pullRequestId,
      'merged',
    );
    await notifyMergedPullRequestThreads(payload, repoFullName);

    return { status: 'ok' };
  }

  const taskType = getReviewTaskType(payload, context);

  if (!taskType) {
    return {
      status: 'ok',
      message: `unsupported_ado_pull_request_event:${payload.eventType}`,
    };
  }

  const headSha = getAdoPullRequestHeadSha(pullRequest);

  const result = await getAdoAutomationTargets({
    type: CloudAgentType.PrReviewer,
    payload: { ...payload, repositoryFullName: repoFullName },
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

    return !pullRequest.isDraft || reviewDraftPrs;
  });

  if (targets.length === 0) {
    return {
      status: 'ok',
      message: 'No Azure DevOps PR reviewer targets found.',
    };
  }

  if (taskType === TaskPayloadKind.GithubPrReviewSync) {
    const syncReviewDecision = await getAdoSyncReviewDecision({
      repoFullName,
      prNumber: pullRequest.pullRequestId,
      headSha,
      context,
    });

    if (!syncReviewDecision.shouldEnqueue) {
      return {
        status: 'ok',
        message: syncReviewDecision.message,
      };
    }
  }

  const branchName = stripAdoGitRefPrefix(pullRequest.sourceRefName);
  const targetBranch = stripAdoGitRefPrefix(pullRequest.targetRefName);

  const prUrl = getAdoPullRequestUrl({
    resourceContainers: payload.resourceContainers,
    pullRequest,
    repositoryFullName: repoFullName,
  });
  const prAuthorName = getAdoIdentityName(pullRequest.createdBy);
  const prAuthorId = pullRequest.createdBy?.id?.trim() || prAuthorName;

  const enqueued = await pMap(targets, async (_target) =>
    enqueueCloudTask(
      {
        task: {
          type: taskType,
          payload: {
            repo: repoFullName,
            sourceControlProvider: 'ado',
            prNumber: pullRequest.pullRequestId,
            prTitle: pullRequest.title,
            prUrl,
            headSha,
            branchName,
            ...(branchName ? { branch: branchName } : {}),
            ...(headSha ? { sha: headSha } : {}),
            targetBranch,
          } satisfies CloudTaskPayload<typeof taskType>,
        },
        initiator: {
          kind: 'automation',
          key: 'review_code',
          ...(prAuthorId
            ? {
                actor: {
                  externalId: prAuthorId,
                  displayName: prAuthorName,
                },
              }
            : {}),
        },
        workflow: 'pr_review',
        surface: 'ado',
        trigger: 'webhook',
        prLinkage: {
          provider: 'ado',
          repository: repoFullName,
          prNumber: pullRequest.pullRequestId,
          prUrl,
          prTitle: pullRequest.title,
          prSha: headSha || null,
          prBaseRef: targetBranch ?? null,
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
