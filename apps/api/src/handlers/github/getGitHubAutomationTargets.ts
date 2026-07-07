import {
  CloudAgentType,
  DEFAULT_PR_REVIEWER_SETTINGS,
  type PrReviewerSettings,
} from '@roomote/types';
import { Schemas as GitHubSchemas } from '@roomote/github';
import {
  type Repository,
  db,
  repositories,
  githubInstallations,
  githubUserMappings,
  environmentRepositoryMappings,
  getReviewCodeAutomationSettings,
  eq,
  and,
} from '@roomote/db/server';

import type {
  WebhookInstallation,
  WebhookRepository,
  WebhookUser,
  WebhookCloudTaskProperties,
} from './types';

type GitHubAutomationTarget = {
  id: string;
  type: CloudAgentType;
  settings: PrReviewerSettings | null;
  repo: Repository;
  collaborators: Array<{ githubLogin: string }>;
  repositoryIds: string[];
  properties: WebhookCloudTaskProperties;
};

type GetGitHubAutomationTargetsOptions = {
  type: CloudAgentType;
  installation?: WebhookInstallation;
  repository: WebhookRepository;
  sender: WebhookUser;
  author?: string;
  ignoreRoomoteAuthorRequirement?: boolean;
  requireLinkedSenderAccount?: boolean;
};

export const getGitHubAutomationTargets = async ({
  type,
  installation,
  repository,
  sender,
  author: collaboratorLogin,
  ignoreRoomoteAuthorRequirement = false,
  requireLinkedSenderAccount = false,
}: GetGitHubAutomationTargetsOptions): Promise<
  | {
      status: 'ok';
      targets: GitHubAutomationTarget[];
    }
  | {
      status: 'error';
      code?: 'account_link_required';
      message: string;
    }
> => {
  const githubInstallationId = installation?.id;

  if (!githubInstallationId) {
    console.log(`[getGitHubAutomationTargets] no_installation`);
    return { status: 'error', message: 'no_installation' };
  }

  const [result] = await db
    .select()
    .from(repositories)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, repositories.installationId),
    )
    .where(
      and(
        eq(githubInstallations.installationId, githubInstallationId),
        eq(repositories.githubRepoId, repository.id),
        eq(repositories.isActive, true),
      ),
    )
    .limit(1);

  const githubUserMapping = await db.query.githubUserMappings.findFirst({
    where: eq(githubUserMappings.githubUserId, sender.id),
  });

  if (requireLinkedSenderAccount && !githubUserMapping?.userId) {
    return {
      status: 'error',
      code: 'account_link_required',
      message: `GitHub user ${sender.login} is not linked to a Roomote user`,
    };
  }

  if (!result) {
    return {
      status: 'error',
      message: `no active repository associated with [${githubInstallationId}, ${repository.full_name}]`,
    };
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
    .where(
      eq(environmentRepositoryMappings.repositoryId, result.repositories.id),
    );

  if (
    type === CloudAgentType.PrReviewer &&
    repositoryEnvironmentIds.length === 0
  ) {
    console.error(
      `[getGitHubAutomationTargets] [${githubInstallationId}, ${repository.full_name}] -> no_environment_mapping`,
    );

    return {
      status: 'error',
      message: `no environment mapping associated with [${githubInstallationId}, ${repository.full_name}]`,
    };
  }

  const reviewerReviewsAllPrs =
    reviewerSettings?.reviewAllPullRequestAuthors ??
    DEFAULT_PR_REVIEWER_SETTINGS.reviewAllPullRequestAuthors;
  const isRoomoteManagedAuthor = collaboratorLogin
    ? Boolean(GitHubSchemas.isRoomoteGitHubLogin(collaboratorLogin))
    : true;

  if (
    type === CloudAgentType.PrReviewer &&
    collaboratorLogin &&
    !ignoreRoomoteAuthorRequirement &&
    !isRoomoteManagedAuthor &&
    !reviewerReviewsAllPrs
  ) {
    console.error(
      `[getGitHubAutomationTargets] [${githubInstallationId}, ${repository.full_name}] -> author_not_allowed`,
    );

    return {
      status: 'error',
      message: `collaborator is not allowed: ${collaboratorLogin}`,
    };
  }

  const userId = githubUserMapping?.userId;
  const target: GitHubAutomationTarget = {
    id: `github:${type}:${result.repositories.id}`,
    type,
    settings: reviewerSettings,
    repo: result.repositories,
    collaborators: [],
    repositoryIds: [result.repositories.id],
    properties: {
      userId,
      githubLogin: sender.login,
      githubUserId: sender.id,
    },
  };

  return { status: 'ok', targets: [target] };
};
