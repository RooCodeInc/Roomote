import { normalizeAdoLinkedAccountKey } from '@roomote/ado';
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
  desc,
  eq,
  and,
  or,
} from '@roomote/db/server';

import type { AdoIdentity, AdoPullRequestWebhook } from './types';

type AdoAutomationWebhookContext = Pick<AdoPullRequestWebhook, 'resource'> & {
  repositoryFullName: string;
  commentAuthor?: AdoIdentity;
};

type AdoAutomationTarget = {
  id: string;
  type: CloudAgentType;
  settings: PrReviewerSettings | null;
  repo: Repository;
  repositoryIds: string[];
  userId: string;
};

export function getAdoIdentityName(
  identity: AdoIdentity | undefined,
): string | undefined {
  return identity?.uniqueName ?? identity?.displayName;
}

export function isRoomoteAdoIdentity(identityName: string): boolean {
  const normalized = identityName.toLowerCase().trim();

  // Match Roomote's own bot by its identity name/handle only. A bare
  // `@roomote` substring check also matched every human whose Azure DevOps
  // uniqueName is an email in a `roomote.*` tenant (e.g.
  // `dan@roomote.onmicrosoft.com`), which silently dropped their `@roomote`
  // PR comment mentions. The comment path additionally guards against
  // Roomote's own posts with `isDeploymentTokenAuthor`, which resolves the
  // exact deployment identity rather than guessing from the name.
  return normalized.startsWith('roomote') || normalized.startsWith('@roomote');
}

export async function getAdoAutomationTargets({
  type,
  payload,
  ignoreAuthorPolicy = false,
  requireLinkedSenderAccount = false,
}: {
  type: CloudAgentType;
  payload: AdoAutomationWebhookContext;
  ignoreAuthorPolicy?: boolean;
  requireLinkedSenderAccount?: boolean;
}): Promise<
  | {
      status: 'ok';
      targets: AdoAutomationTarget[];
    }
  | {
      status: 'error';
      code?: 'account_link_required';
      message: string;
    }
> {
  const repositoryId = payload.resource.repository.id;
  const fullName = payload.repositoryFullName;
  const authorName = getAdoIdentityName(payload.resource.createdBy);
  // Linked accounts are keyed on the commenter's normalized uniqueName
  // (UPN/email); the comment author's raw `id` is a different Azure DevOps id
  // namespace than the one stored at link time and never matches.
  const senderLinkedAccountKey = normalizeAdoLinkedAccountKey(
    payload.commentAuthor?.uniqueName,
  );
  const senderName = getAdoIdentityName(payload.commentAuthor);

  const repo = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, 'ado'),
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
      message: `no active Azure DevOps repository associated with [${repositoryId}, ${fullName ?? 'unknown'}]`,
    };
  }

  let linkedSenderUserId: string | null = null;

  if (requireLinkedSenderAccount) {
    const linkedAccount = senderLinkedAccountKey
      ? await db.query.authAccounts.findFirst({
          where: and(
            eq(authAccounts.providerId, 'ado'),
            eq(authAccounts.accountId, senderLinkedAccountKey),
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
        message: `Azure DevOps user ${senderName ?? senderLinkedAccountKey ?? 'unknown'} is not linked to a Roomote user`,
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
      message: `no environment mapping associated with [ado:${repositoryId}, ${repo.fullName}]`,
    };
  }

  const reviewerReviewsAllPrs =
    reviewerSettings?.reviewAllPullRequestAuthors ??
    DEFAULT_PR_REVIEWER_SETTINGS.reviewAllPullRequestAuthors;

  if (
    type === CloudAgentType.PrReviewer &&
    !ignoreAuthorPolicy &&
    authorName &&
    !isRoomoteAdoIdentity(authorName) &&
    !reviewerReviewsAllPrs
  ) {
    return {
      status: 'error',
      message: `Azure DevOps PR author is not allowed: ${authorName}`,
    };
  }

  return {
    status: 'ok',
    targets: [
      {
        id: `ado:${type}:${repo.id}`,
        type,
        settings: reviewerSettings,
        repo,
        repositoryIds: [repo.id],
        userId: linkedSenderUserId ?? repo.linkedByUserId,
      },
    ],
  };
}
