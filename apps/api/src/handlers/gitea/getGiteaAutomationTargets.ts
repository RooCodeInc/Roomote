import {
  CloudAgentType,
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
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

import type {
  GiteaPullRequestCommentWebhook,
  GiteaPullRequestWebhook,
} from './types';

type GiteaUser = NonNullable<GiteaPullRequestWebhook['sender']>;

type GiteaAutomationWebhookContext = Pick<
  GiteaPullRequestWebhook,
  'repository' | 'sender'
> & {
  commentAuthor?: GiteaPullRequestCommentWebhook['comment']['user'];
};

type GiteaAutomationTarget = {
  id: string;
  type: CloudAgentType;
  settings: PrReviewerSettings | null;
  repo: Repository;
  repositoryIds: string[];
  userId: string | null;
};

export function getGiteaUsername(
  user: GiteaAutomationWebhookContext['sender'],
): string | undefined {
  return user?.login ?? user?.username;
}

export function isRoomoteGiteaUsername(username: string): boolean {
  return username.toLowerCase().startsWith('roomote');
}

function getGiteaUserId(user: GiteaUser | undefined): string | null {
  return typeof user?.id === 'number' && Number.isFinite(user.id)
    ? String(user.id)
    : null;
}

export async function getGiteaAutomationTargets({
  type,
  payload,
  ignoreAuthorPolicy = false,
  requireLinkedSenderAccount = false,
}: {
  type: CloudAgentType;
  payload: GiteaAutomationWebhookContext;
  ignoreAuthorPolicy?: boolean;
  requireLinkedSenderAccount?: boolean;
}): Promise<
  | {
      status: 'ok';
      targets: GiteaAutomationTarget[];
    }
  | {
      status: 'error';
      code?: 'account_link_required';
      message: string;
    }
> {
  const repositoryId = String(payload.repository.id);
  const fullName = payload.repository.full_name;
  const authorUsername = getGiteaUsername(payload.sender);
  const sender = payload.commentAuthor ?? payload.sender;
  const senderGiteaUserId = getGiteaUserId(sender);
  const senderUsername = getGiteaUsername(sender) ?? authorUsername;
  let linkedSenderUserId: string | null = null;

  const repo = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'gitea'),
      eq(repositories.isActive, true),
      fullName
        ? or(
            eq(repositories.externalRepoId, repositoryId),
            eq(repositories.fullName, fullName),
          )
        : eq(repositories.externalRepoId, repositoryId),
    ),
  });

  if (!repo) {
    return {
      status: 'error',
      message: `no active Gitea repository associated with [${repositoryId}, ${fullName ?? 'unknown'}]`,
    };
  }

  if (requireLinkedSenderAccount) {
    const linkedAccount = senderGiteaUserId
      ? await db.query.authAccounts.findFirst({
          where: and(
            eq(authAccounts.providerId, 'gitea'),
            eq(authAccounts.accountId, senderGiteaUserId),
          ),
          orderBy: [desc(authAccounts.updatedAt)],
          columns: {
            userId: true,
          },
        })
      : null;

    linkedSenderUserId = linkedAccount?.userId ?? null;

    if (!linkedSenderUserId) {
      return {
        status: 'error',
        code: 'account_link_required',
        message: `Gitea user ${senderUsername ?? senderGiteaUserId ?? 'unknown'} is not linked to a Roomote user`,
      };
    }
  }

  const reviewerSettings =
    type === CloudAgentType.PrReviewer
      ? await getReviewCodeAutomationSettings()
      : null;

  if (
    type === CloudAgentType.PrReviewer &&
    (reviewerSettings?.enabled ?? DEFAULT_PR_REVIEWER_SETTINGS.enabled) ===
      false
  ) {
    return { status: 'ok', targets: [] };
  }

  const repositoryEnvironmentIds = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
    })
    .from(environmentRepositoryMappings)
    .where(eq(environmentRepositoryMappings.repositoryId, repo.id));

  if (
    type === CloudAgentType.PrReviewer &&
    repositoryEnvironmentIds.length === 0
  ) {
    return {
      status: 'error',
      message: `no environment mapping associated with [gitea:${repositoryId}, ${repo.fullName}]`,
    };
  }

  const reviewerReviewsAllPrs =
    reviewerSettings?.reviewAllPullRequestAuthors ??
    DEFAULT_PR_REVIEWER_SETTINGS.reviewAllPullRequestAuthors;

  if (
    type === CloudAgentType.PrReviewer &&
    !ignoreAuthorPolicy &&
    authorUsername &&
    !isRoomoteGiteaUsername(authorUsername) &&
    !reviewerReviewsAllPrs
  ) {
    return {
      status: 'error',
      message: `Gitea PR author is not allowed: ${authorUsername}`,
    };
  }

  return {
    status: 'ok',
    targets: [
      {
        id: `gitea:${type}:${repo.id}`,
        type,
        settings: reviewerSettings,
        repo,
        repositoryIds: [repo.id],
        userId: linkedSenderUserId,
      },
    ],
  };
}
