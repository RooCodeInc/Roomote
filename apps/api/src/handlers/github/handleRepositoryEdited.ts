import { and, db, eq, ne, repositories } from '@roomote/db/server';

import type { WebhookResponse } from '../../types';

interface RepositoryEditedPayload {
  action: string;
  changes?: {
    default_branch?: { from?: string | null } | null;
  } | null;
  repository: {
    id: number;
    full_name: string;
    default_branch: string;
  };
  installation?: { id: number } | null;
}

/**
 * Keep stored repository metadata in sync when the default branch changes
 * on GitHub. Stale `default_branch` rows otherwise persist until a manual
 * installation resync and break implicit-branch checkouts downstream.
 */
export async function handleRepositoryEdited(
  payload: RepositoryEditedPayload,
): Promise<WebhookResponse> {
  if (!payload.changes?.default_branch) {
    return { status: 'ok', message: 'Ignoring non-default-branch edit' };
  }

  const defaultBranch = payload.repository.default_branch;

  const updated = await db
    .update(repositories)
    .set({ defaultBranch, updatedAt: new Date() })
    .where(
      and(
        eq(repositories.sourceControlProvider, 'github'),
        eq(repositories.githubRepoId, payload.repository.id),
        ne(repositories.defaultBranch, defaultBranch),
      ),
    )
    .returning({ id: repositories.id });

  return {
    status: 'ok',
    message: `Updated default branch for ${payload.repository.full_name} to ${defaultBranch}`,
    metadata: { updatedRepositoryCount: updated.length },
  };
}
