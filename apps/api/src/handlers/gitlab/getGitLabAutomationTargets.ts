import {
  DEFAULT_PR_REVIEW_SETTINGS,
  type PrReviewSettings,
  type SourceControlAutomationWorkflow,
} from '@roomote/types';
import {
  type Repository,
  authAccounts,
  db,
  repositories,
  environmentRepositoryMappings,
  getReviewCodeAutomationSettings,
  eq,
  and,
  desc,
  or,
} from '@roomote/db/server';

import type { GitLabMergeRequestWebhook } from './types';

type GitLabAutomationWebhookContext = Pick<
  GitLabMergeRequestWebhook,
  'project' | 'user'
>;

type GitLabAutomationTarget = {
  id: string;
  workflow: SourceControlAutomationWorkflow;
  settings: PrReviewSettings | null;
  repo: Repository;
  repositoryIds: string[];
  userId: string | null;
};

export function isRoomoteGitLabUsername(username: string): boolean {
  return username.toLowerCase().startsWith('roomote');
}

export async function getGitLabAutomationTargets({
  workflow,
  payload,
  ignoreAuthorPolicy = false,
  requireLinkedSenderAccount = false,
}: {
  workflow: SourceControlAutomationWorkflow;
  payload: GitLabAutomationWebhookContext;
  ignoreAuthorPolicy?: boolean;
  requireLinkedSenderAccount?: boolean;
}): Promise<
  | {
      status: 'ok';
      targets: GitLabAutomationTarget[];
    }
  | {
      status: 'error';
      code?: 'account_link_required';
      message: string;
    }
> {
  const projectId = String(payload.project.id);
  const fullName = payload.project.path_with_namespace;
  const senderGitLabUserId =
    typeof payload.user?.id === 'number' && Number.isFinite(payload.user.id)
      ? String(payload.user.id)
      : null;
  const authorUsername = payload.user?.username;
  let linkedSenderUserId: string | null = null;

  const repo = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'gitlab'),
      eq(repositories.isActive, true),
      fullName
        ? or(
            eq(repositories.externalRepoId, projectId),
            eq(repositories.fullName, fullName),
          )
        : eq(repositories.externalRepoId, projectId),
    ),
  });

  if (!repo) {
    return {
      status: 'error',
      message: `no active GitLab repository associated with [${projectId}, ${fullName ?? 'unknown'}]`,
    };
  }

  if (requireLinkedSenderAccount) {
    const linkedAccount = senderGitLabUserId
      ? await db.query.authAccounts.findFirst({
          where: and(
            eq(authAccounts.providerId, 'gitlab'),
            eq(authAccounts.accountId, senderGitLabUserId),
          ),
          orderBy: [desc(authAccounts.updatedAt)],
          columns: {
            userId: true,
          },
        })
      : null;

    if (!linkedAccount?.userId) {
      return {
        status: 'error',
        code: 'account_link_required',
        message: `GitLab user ${authorUsername ?? senderGitLabUserId ?? 'unknown'} is not linked to a Roomote user`,
      };
    }

    linkedSenderUserId = linkedAccount.userId;
  }

  const reviewerSettings =
    workflow === 'pr_review' ? await getReviewCodeAutomationSettings() : null;

  if (
    workflow === 'pr_review' &&
    (reviewerSettings?.enabled ?? DEFAULT_PR_REVIEW_SETTINGS.enabled) === false
  ) {
    return { status: 'ok', targets: [] };
  }

  const repositoryEnvironmentIds = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
    })
    .from(environmentRepositoryMappings)
    .where(eq(environmentRepositoryMappings.repositoryId, repo.id));

  if (workflow === 'pr_review' && repositoryEnvironmentIds.length === 0) {
    return {
      status: 'error',
      message: `no environment mapping associated with [gitlab:${projectId}, ${repo.fullName}]`,
    };
  }

  const reviewerReviewsAllPrs =
    reviewerSettings?.reviewAllPullRequestAuthors ??
    DEFAULT_PR_REVIEW_SETTINGS.reviewAllPullRequestAuthors;

  if (
    workflow === 'pr_review' &&
    !ignoreAuthorPolicy &&
    authorUsername &&
    !isRoomoteGitLabUsername(authorUsername) &&
    !reviewerReviewsAllPrs
  ) {
    return {
      status: 'error',
      message: `GitLab MR author is not allowed: ${authorUsername}`,
    };
  }

  return {
    status: 'ok',
    targets: [
      {
        id: `gitlab:${workflow}:${repo.id}`,
        workflow,
        settings: reviewerSettings,
        repo,
        repositoryIds: [repo.id],
        userId: linkedSenderUserId,
      },
    ],
  };
}
