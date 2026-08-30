import pMap from 'p-map';

import {
  type TaskPayload,
  DEFAULT_PR_REVIEW_SETTINGS,
  type PrReviewSettings,
  TaskPayloadKind,
  RunStatus,
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
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  recordPrStatusChangeInTaskHistory,
  updateTaskPrStatus,
} from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { scheduleNotifyPullRequestTerminalStatus } from '../github/notifyPullRequestTerminalStatus';
import { scheduleSourceControlPullRequestFactSync } from '../pull-request-fact-sync';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
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

async function notifyTerminalPullRequestThreads(
  payload: AdoPullRequestWebhook,
  repoFullName: string,
  status: 'merged' | 'closed',
): Promise<void> {
  const prUrl = getAdoPullRequestUrl({
    resourceContainers: payload.resourceContainers,
    pullRequest: payload.resource,
    repositoryFullName: repoFullName,
  });
  const webhookHost = toHostFromUrl(prUrl);
  const repositoryRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'ado'),
      eq(repositories.fullName, repoFullName),
      eq(repositories.isActive, true),
    ),
    columns: { id: true, host: true },
  });
  const repositoryRow = pickHostScopedRepository(repositoryRows, webhookHost);

  if (!repositoryRow) {
    return;
  }

  scheduleNotifyPullRequestTerminalStatus(
    {
      sourceControlProvider: 'ado',
      repository: repoFullName,
      repositoryId: repositoryRow.id,
      host: repositoryRow.host ?? webhookHost,
      prNumber: payload.resource.pullRequestId,
      prTitle: payload.resource.title,
      prUrl,
      status,
      actorLogin:
        getAdoIdentityName(payload.resource.closedBy) ??
        'someone in Azure DevOps',
    },
    `PR #${payload.resource.pullRequestId}`,
  );
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
        sql`${taskRuns.status} != ${RunStatus.Failed}`,
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
        sql`${taskRuns.status} != ${RunStatus.Failed}`,
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

function scheduleAdoPullRequestFactSync(
  payload: AdoPullRequestWebhook,
  repoFullName: string,
  status: 'merged' | 'closed',
): void {
  const pullRequest = payload.resource;

  scheduleSourceControlPullRequestFactSync({
    provider: 'ado',
    repositoryFullName: repoFullName,
    pullRequest: {
      number: pullRequest.pullRequestId,
      title: pullRequest.title,
      body: pullRequest.description ?? null,
      url: getAdoPullRequestUrl({
        resourceContainers: payload.resourceContainers,
        pullRequest,
        repositoryFullName: repoFullName,
      }),
      authorLogin: getAdoIdentityName(pullRequest.createdBy) ?? null,
      state: status,
      createdAt: pullRequest.creationDate ?? null,
      // Azure DevOps webhooks carry no last-updated timestamp; closedDate is
      // the terminal-event time.
      updatedAt: pullRequest.closedDate ?? null,
      mergedAt: status === 'merged' ? (pullRequest.closedDate ?? null) : null,
    },
  });
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

    scheduleAdoPullRequestFactSync(payload, repoFullName, 'closed');

    await Promise.resolve(
      recordPrStatusChangeInTaskHistory({
        sourceControlProvider: 'ado',
        repository: repoFullName,
        prNumber: pullRequest.pullRequestId,
        prTitle: pullRequest.title,
        prUrl: getAdoPullRequestUrl({
          resourceContainers: payload.resourceContainers,
          pullRequest,
          repositoryFullName: repoFullName,
        }),
        targetBranch: stripAdoGitRefPrefix(pullRequest.targetRefName),
        status: 'closed',
        actorLogin:
          getAdoIdentityName(payload.resource.closedBy) ??
          'someone in Azure DevOps',
      }),
    ).catch((error) => {
      console.warn(
        `[handleAdoPullRequest] Failed to record PR status in task history for ${repoFullName}#${pullRequest.pullRequestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    await notifyTerminalPullRequestThreads(payload, repoFullName, 'closed');

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

    scheduleAdoPullRequestFactSync(payload, repoFullName, 'merged');

    await Promise.resolve(
      recordPrStatusChangeInTaskHistory({
        sourceControlProvider: 'ado',
        repository: repoFullName,
        prNumber: pullRequest.pullRequestId,
        prTitle: pullRequest.title,
        prUrl: getAdoPullRequestUrl({
          resourceContainers: payload.resourceContainers,
          pullRequest,
          repositoryFullName: repoFullName,
        }),
        targetBranch: stripAdoGitRefPrefix(pullRequest.targetRefName),
        status: 'merged',
        actorLogin:
          getAdoIdentityName(payload.resource.closedBy) ??
          'someone in Azure DevOps',
      }),
    ).catch((error) => {
      console.warn(
        `[handleAdoPullRequest] Failed to record PR status in task history for ${repoFullName}#${pullRequest.pullRequestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    await notifyTerminalPullRequestThreads(payload, repoFullName, 'merged');

    return { status: 'ok' };
  }

  if (
    pullRequest.status === 'active' &&
    (payload.eventType === 'git.pullrequest.created' ||
      payload.eventType === 'git.pullrequest.updated')
  ) {
    await updateTaskPrStatus(
      'ado',
      repoFullName,
      pullRequest.pullRequestId,
      pullRequest.isDraft ? 'draft' : 'open',
    );
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
    workflow: 'pr_review',
    payload: { ...payload, repositoryFullName: repoFullName },
    // The PR web URL (or the account/collection base URL it is built from)
    // carries the instance host, matching repositories.host.
    webhookHost: toHostFromUrl(
      getAdoPullRequestUrl({
        resourceContainers: payload.resourceContainers,
        pullRequest,
        repositoryFullName: repoFullName,
      }),
    ),
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

  const enqueued = await pMap(targets, async (target) =>
    enqueueTask(
      {
        task: {
          type: taskType,
          payload: {
            repo: repoFullName,
            sourceControlProvider: 'ado',
            // Pin repository resolution to the webhook repository's host so
            // same-name repositories on other hosts cannot be picked up.
            // Legacy rows without a recorded host omit the field.
            ...(target.repo.host
              ? { sourceControlHost: target.repo.host }
              : {}),
            prNumber: pullRequest.pullRequestId,
            prTitle: pullRequest.title,
            prUrl,
            headSha,
            branchName,
            ...(branchName ? { branch: branchName } : {}),
            ...(headSha ? { sha: headSha } : {}),
            targetBranch,
          } satisfies TaskPayload<typeof taskType>,
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
          ...(target.repo.host ? { host: target.repo.host } : {}),
          repositoryId: target.repo.id,
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
