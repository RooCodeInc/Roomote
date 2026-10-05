import type {
  PrReviewSettings,
  SourceControlAutomationWorkflow,
} from '@roomote/types';
import { Schemas as GitHubSchemas } from '@roomote/github';
import {
  type Repository,
  db,
  repositories,
  githubInstallations,
  githubUserMappings,
  getReviewCodeAutomationSettings,
  eq,
  and,
} from '@roomote/db/server';

import type {
  WebhookInstallation,
  WebhookRepository,
  WebhookUser,
  WebhookTaskProperties,
} from './types';
import { getPrReviewTargetEligibility } from '../shared/pr-review-target-eligibility';

type GitHubAutomationTarget = {
  id: string;
  workflow: SourceControlAutomationWorkflow;
  settings: PrReviewSettings | null;
  repo: Repository;
  collaborators: Array<{ githubLogin: string }>;
  repositoryIds: string[];
  properties: WebhookTaskProperties;
};

type GetGitHubAutomationTargetsOptions = {
  workflow: SourceControlAutomationWorkflow;
  installation?: WebhookInstallation;
  repository: WebhookRepository;
  sender: WebhookUser;
  author?: string;
  ignoreRoomoteAuthorRequirement?: boolean;
  requireLinkedSenderAccount?: boolean;
};

export const getGitHubAutomationTargets = async ({
  workflow,
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
    workflow === 'pr_review' ? await getReviewCodeAutomationSettings() : null;

  const eligibility = getPrReviewTargetEligibility(
    workflow,
    reviewerSettings,
    ignoreRoomoteAuthorRequirement,
    collaboratorLogin
      ? Boolean(GitHubSchemas.isRoomoteGitHubLogin(collaboratorLogin))
      : null,
  );

  if (eligibility === 'automation_disabled') {
    return { status: 'ok', targets: [] };
  }

  if (eligibility === 'author_not_allowed') {
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
    id: `github:${workflow}:${result.repositories.id}`,
    workflow,
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
