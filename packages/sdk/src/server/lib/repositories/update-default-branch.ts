import { TRPCError } from '@trpc/server';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';
import {
  isExitedRunStatus,
  resolveSourceControlHostFromPayload,
  resolveTaskWorkspace,
} from '@roomote/types';
import {
  db,
  repositories,
  taskRuns,
  environmentRepositoryMappings,
  eq,
  and,
  ne,
} from '@roomote/db/server';

import { isRunToken } from '../../trpc';

/**
 * A run token may only report for repositories its own workspace references:
 * the single selected repository, a member of the selected set, any active
 * repository for all-repositories tasks, or a repository mapped into the
 * run's environment. Terminal runs refuse the token like every other
 * run-scoped surface.
 *
 * Name-based workspace shapes additionally bind to the payload's stamped
 * source-control provider and host when present, mirroring the provider
 * filter the worker itself applies when listing repositories — a run stamped
 * for one provider or self-managed host cannot report for a same-name
 * repository on another. A host-stamped run requires an equal row host —
 * legacy null-host rows are refused rather than risk crossing self-managed
 * instances; a stampless payload falls back to (provider, fullName),
 * matching the rest of the host-aware lookups.
 */
async function runMayReportForRepository(
  runId: number,
  repository: {
    id: string;
    fullName: string;
    sourceControlProvider: string;
    host: string | null;
  },
): Promise<boolean> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { id: true, status: true, payload: true },
  });

  if (!run || isExitedRunStatus(run.status)) {
    return false;
  }

  const stampedProvider = (run.payload as { sourceControlProvider?: unknown })
    .sourceControlProvider;
  const stampedHost = resolveSourceControlHostFromPayload(
    run.payload as { sourceControlHost?: unknown },
  );
  const providerMatches =
    typeof stampedProvider === 'string' && stampedProvider !== ''
      ? stampedProvider === repository.sourceControlProvider
      : true;
  const hostMatches = stampedHost ? stampedHost === repository.host : true;
  const identityMatches = providerMatches && hostMatches;

  let workspace: ReturnType<typeof resolveTaskWorkspace>;

  try {
    workspace = resolveTaskWorkspace(run.payload);
  } catch {
    return false;
  }

  switch (workspace.type) {
    case 'repository':
      return identityMatches && workspace.repo === repository.fullName;
    case 'repository_set':
      return (
        identityMatches && workspace.repositories.includes(repository.fullName)
      );
    case 'all_repositories':
      return identityMatches;
    case 'environment': {
      const mappings = await db
        .select({ repositoryId: environmentRepositoryMappings.repositoryId })
        .from(environmentRepositoryMappings)
        .where(
          and(
            eq(
              environmentRepositoryMappings.environmentId,
              workspace.environmentId,
            ),
            eq(environmentRepositoryMappings.repositoryId, repository.id),
          ),
        )
        .limit(1);

      return mappings.length > 0;
    }
  }
}

export const updateRepositoryDefaultBranch = async (
  auth: AuthTokenContext | RunTokenContext,
  input: {
    repositoryId: string;
    defaultBranch: string;
  },
) => {
  const repository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.id, input.repositoryId),
      eq(repositories.isActive, true),
    ),
    columns: {
      id: true,
      fullName: true,
      defaultBranch: true,
      sourceControlProvider: true,
      host: true,
    },
  });

  if (!repository) {
    return { updatedCount: 0 };
  }

  if (
    isRunToken(auth) &&
    !(await runMayReportForRepository(auth.runId, repository))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'This run is not authorized to report a default branch for that repository.',
    });
  }

  // Workers report the branch they actually resolved from origin/HEAD so
  // stale synced metadata self-heals without waiting for a manual
  // installation resync. The `ne` guard keeps repeat reports no-ops.
  const updated = await db
    .update(repositories)
    .set({ defaultBranch: input.defaultBranch, updatedAt: new Date() })
    .where(
      and(
        eq(repositories.id, repository.id),
        ne(repositories.defaultBranch, input.defaultBranch),
      ),
    )
    .returning({ id: repositories.id });

  return { updatedCount: updated.length };
};
