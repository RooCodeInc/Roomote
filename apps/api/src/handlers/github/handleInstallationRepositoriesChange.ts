import { db, eq, githubInstallations } from '@roomote/db/server';
import * as GitHub from '@roomote/github';

import type { WebhookResponse } from '../../types';

interface InstallationRepositoriesChangePayload {
  installation?: { id?: number } | null;
}

/**
 * Resync an installation's repository list when its accessible repositories
 * change on GitHub: `installation_repositories.added/removed` (selected-repos
 * installs) and `repository.created/deleted/renamed` (all-repos installs emit
 * these instead). A full resync is used rather than a narrow upsert because
 * these payloads omit fields the `repositories` row needs (default branch,
 * clone URL), and `syncRepositories` already handles upsert + deactivation.
 */
export async function handleInstallationRepositoriesChange(
  payload: InstallationRepositoriesChangePayload,
): Promise<WebhookResponse> {
  const installationId = payload.installation?.id;

  if (typeof installationId !== 'number') {
    return { status: 'ok', message: 'missing_installation' };
  }

  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
    columns: { installedByUserId: true },
  });

  if (!installation) {
    return { status: 'ok', message: 'unknown_installation' };
  }

  const result = await GitHub.syncGitHubInstallation({
    userId: installation.installedByUserId,
    installationId,
  });

  if (!result.success) {
    return {
      status: 'error',
      message: `Failed to resync installation ${installationId}: ${result.error}`,
    };
  }

  return {
    status: 'ok',
    message: `Resynced installation ${installationId}`,
    metadata: { repositoryCount: result.repositories.length },
  };
}
