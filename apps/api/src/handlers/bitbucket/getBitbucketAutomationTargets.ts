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
  sql,
} from '@roomote/db/server';
import { normalizeBitbucketLinkedAccountKey } from '@roomote/bitbucket';

import type {
  BitbucketPullRequestCommentWebhook,
  BitbucketPullRequestWebhook,
  BitbucketWebhookUser,
} from './types';
import { getBitbucketRepositoryExternalId } from './types';

type BitbucketAutomationWebhookContext = Pick<
  BitbucketPullRequestWebhook,
  'repository' | 'actor'
> & {
  commentAuthor?: BitbucketPullRequestCommentWebhook['comment']['user'];
};

type BitbucketAutomationTarget = {
  id: string;
  workflow: SourceControlAutomationWorkflow;
  settings: PrReviewSettings | null;
  repo: Repository;
  repositoryIds: string[];
  userId: string | null;
};

export function getBitbucketUsername(
  user: BitbucketWebhookUser | undefined,
): string | undefined {
  return user?.username ?? user?.nickname ?? user?.display_name;
}

export function isRoomoteBitbucketUsername(username: string): boolean {
  return username.toLowerCase().startsWith('roomote');
}

export function getBitbucketUserAccountKey(
  user: BitbucketWebhookUser | undefined,
): string | null {
  if (user?.account_id?.trim()) {
    return normalizeBitbucketLinkedAccountKey(user.account_id);
  }

  if (user?.uuid?.trim()) {
    return normalizeBitbucketLinkedAccountKey(user.uuid);
  }

  return null;
}

export async function getBitbucketAutomationTargets({
  workflow,
  payload,
  ignoreAuthorPolicy = false,
  requireLinkedSenderAccount = false,
}: {
  workflow: SourceControlAutomationWorkflow;
  payload: BitbucketAutomationWebhookContext;
  ignoreAuthorPolicy?: boolean;
  requireLinkedSenderAccount?: boolean;
}): Promise<
  | {
      status: 'ok';
      targets: BitbucketAutomationTarget[];
    }
  | {
      status: 'error';
      code?: 'account_link_required';
      message: string;
    }
> {
  const repositoryId = getBitbucketRepositoryExternalId(payload.repository);
  const fullName = payload.repository.full_name;
  const authorUsername = getBitbucketUsername(payload.actor);
  const sender = payload.commentAuthor ?? payload.actor;
  const senderBitbucketUserId = getBitbucketUserAccountKey(sender);
  const senderUsername = getBitbucketUsername(sender) ?? authorUsername;
  let linkedSenderUserId: string | null = null;

  const repo = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'bitbucket'),
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
      message: `no active Bitbucket repository associated with [${repositoryId}, ${fullName ?? 'unknown'}]`,
    };
  }

  if (requireLinkedSenderAccount) {
    const linkedAccount = senderBitbucketUserId
      ? await db.query.authAccounts.findFirst({
          where: and(
            eq(authAccounts.providerId, 'bitbucket'),
            sql`lower(replace(replace(${authAccounts.accountId}, '{', ''), '}', '')) = ${senderBitbucketUserId}`,
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
        message: `Bitbucket user ${senderUsername ?? senderBitbucketUserId ?? 'unknown'} is not linked to a Roomote user`,
      };
    }
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
      message: `no environment mapping associated with [bitbucket:${repositoryId}, ${repo.fullName}]`,
    };
  }

  const reviewerReviewsAllPrs =
    reviewerSettings?.reviewAllPullRequestAuthors ??
    DEFAULT_PR_REVIEW_SETTINGS.reviewAllPullRequestAuthors;

  if (
    workflow === 'pr_review' &&
    !ignoreAuthorPolicy &&
    authorUsername &&
    !isRoomoteBitbucketUsername(authorUsername) &&
    !reviewerReviewsAllPrs
  ) {
    return {
      status: 'error',
      message: `Bitbucket PR author is not allowed: ${authorUsername}`,
    };
  }

  return {
    status: 'ok',
    targets: [
      {
        id: `bitbucket:${workflow}:${repo.id}`,
        workflow,
        settings: reviewerSettings,
        repo,
        repositoryIds: [repo.id],
        userId: linkedSenderUserId,
      },
    ],
  };
}
