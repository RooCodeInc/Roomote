import type {
  PrReviewSettings,
  SourceControlAutomationWorkflow,
} from '@roomote/types';
import {
  type Repository,
  authAccounts,
  db,
  repositories,
  getReviewCodeAutomationSettings,
  eq,
  and,
  desc,
  or,
} from '@roomote/db/server';

import { pickHostScopedRepository } from '../utils';
import { getPrReviewTargetEligibility } from '../shared/pr-review-target-eligibility';
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
  workflow: SourceControlAutomationWorkflow;
  settings: PrReviewSettings | null;
  repo: Repository;
  repositoryIds: string[];
  userId: string | null;
};

export function getGiteaUsername(
  user: GiteaAutomationWebhookContext['sender'],
): string | undefined {
  const login = user?.login?.trim();
  if (login) {
    return login;
  }

  const username = user?.username?.trim();
  if (username) {
    return username;
  }

  return undefined;
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
  workflow,
  payload,
  webhookHost = null,
  ignoreAuthorPolicy = false,
  requireLinkedSenderAccount = false,
}: {
  workflow: SourceControlAutomationWorkflow;
  payload: GiteaAutomationWebhookContext;
  /**
   * Instance host derived from the webhook's own URLs. Scopes the repository
   * lookup host-first (legacy NULL-host rows as fallback) so same-name
   * repositories on other self-managed hosts are never selected.
   */
  webhookHost?: string | null;
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

  const repoRows = await db.query.repositories.findMany({
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
  const repo = pickHostScopedRepository(repoRows, webhookHost);

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
    workflow === 'pr_review' ? await getReviewCodeAutomationSettings() : null;

  const eligibility = getPrReviewTargetEligibility(
    workflow,
    reviewerSettings,
    ignoreAuthorPolicy,
    authorUsername ? isRoomoteGiteaUsername(authorUsername) : null,
  );

  if (eligibility === 'automation_disabled') {
    return { status: 'ok', targets: [] };
  }

  if (eligibility === 'author_not_allowed') {
    return {
      status: 'error',
      message: `Gitea PR author is not allowed: ${authorUsername}`,
    };
  }

  return {
    status: 'ok',
    targets: [
      {
        id: `gitea:${workflow}:${repo.id}`,
        workflow,
        settings: reviewerSettings,
        repo,
        repositoryIds: [repo.id],
        userId: linkedSenderUserId,
      },
    ],
  };
}
