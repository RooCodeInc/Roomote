import * as GitHub from '@roomote/github';

import {
  db,
  githubInstallations,
  githubPendingInstallations,
  repositories,
  eq,
  and,
  isNull,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

export async function getGitHubInstallationsCommand(_auth: UserAuthSuccess) {
  return db.query.githubInstallations.findMany({
    where: isNull(githubInstallations.suspendedAt),
  });
}

export async function getGitHubPendingInstallationsCommand(
  auth: UserAuthSuccess,
) {
  const pending = await db.query.githubPendingInstallations.findMany({
    where: eq(githubPendingInstallations.requestedByUserId, auth.userId),
    columns: { id: true },
  });

  return { pending: pending.length > 0 };
}

export async function getBranchesCommand(
  auth: UserAuthSuccess,
  input: { fullName: string },
) {
  return GitHub.getBranches({ userId: auth.userId, fullName: input.fullName });
}

export async function getCollaboratorsCommand(auth: UserAuthSuccess) {
  return GitHub.getCollaborators({ userId: auth.userId });
}

export async function getIssuesCommand(auth: UserAuthSuccess) {
  const repositoryIds = await getOrganizationRepositoryIds(auth);

  if (repositoryIds.length === 0) {
    return [];
  }

  return GitHub.getIssues({
    userId: auth.userId,
    repositoryIds,
    options: { stopAfter: 0 },
  });
}

export async function getPullRequestsCommand(auth: UserAuthSuccess) {
  const repositoryIds = await getOrganizationRepositoryIds(auth);

  if (repositoryIds.length === 0) {
    return [];
  }

  return GitHub.getPullRequests({
    userId: auth.userId,
    repositoryIds,
    options: { stopAfter: 0 },
  });
}

async function getOrganizationRepositoryIds(_auth: UserAuthSuccess) {
  return (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(
        githubInstallations,
        eq(repositories.installationId, githubInstallations.id),
      )
      .where(
        and(
          eq(repositories.isActive, true),
          isNull(githubInstallations.suspendedAt),
        ),
      )
  ).map(({ id }) => id);
}

export {
  startCreateGitHubInstallationCommand,
  startCreateGitHubAppManifestCommand,
  enableGitHubAppCommand,
  finishCreateGitHubInstallationCommand,
  resolvePendingGitHubInstallationsCommand,
  finishCreateGitHubAppManifestCommand,
  startAuthenticateGitHubAccountCommand,
  finishAuthenticateGitHubAccountCommand,
  syncGitHubInstallationCommand,
  syncGitHubInstallationsCommand,
  disableGitHubAppCommand,
  getPullRequestCommand,
  executeRevertCommitCommand,
} from './mutations';
