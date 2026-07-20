import {
  and,
  db,
  eq,
  githubInstallations,
  inArray,
  isNull,
  mcpConnections,
  repositories,
  slackInstallations,
} from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

export async function hasActiveSlackInstallation() {
  const installation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    columns: { id: true },
  });

  return Boolean(installation);
}

export async function hasActiveSentryIntegration() {
  return hasActiveDeploymentMcpConnection('sentry');
}

export async function hasActiveGitHubInstallation() {
  const installation = await db.query.githubInstallations.findFirst({
    where: isNull(githubInstallations.suspendedAt),
    columns: { id: true },
  });

  return Boolean(installation);
}

export async function hasActiveRepository(
  sourceControlProviders?: readonly SourceControlProvider[],
) {
  if (sourceControlProviders?.length === 0) {
    return false;
  }

  const repository = await db.query.repositories.findFirst({
    where: sourceControlProviders
      ? and(
          eq(repositories.isActive, true),
          inArray(repositories.sourceControlProvider, [
            ...sourceControlProviders,
          ]),
        )
      : eq(repositories.isActive, true),
    columns: { id: true },
  });

  return Boolean(repository);
}

async function hasActiveDeploymentMcpConnection(mcpId: string) {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, mcpId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
      isNull(mcpConnections.userId),
    ),
    columns: { id: true },
  });

  return Boolean(connection);
}
