import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { sdk } from '@roomote/sdk/client';
import type { SandboxPrepareRepositoryResult } from '@roomote/sdk/sandbox-router';
import {
  DEFAULT_SOURCE_CONTROL_PROVIDER,
  resolveRepositoryProvidersFromPayload,
  resolveSourceControlProviderFromPayload,
  resolveTaskWorkspace,
  type SourceControlProvider,
} from '@roomote/types';

import { listOnDemandRepositories } from '../../commands/setup/workspace/list-on-demand-repositories';
import { createWorkspaceManager } from '../../commands/setup/workspace/shared';
import { isCredentialWriteBarrierEngaged } from '../../lib/credential-write-barrier';
import {
  ON_DEMAND_REPOSITORIES_MANIFEST_FILE,
  discoverClonedRepositoryPaths,
  resolveOnDemandRepositoryPath,
  writeRepositoriesManifest,
} from '../../workspace/on-demand-repositories';
import { publicProcedure } from '../trpc';

const prepareRepositoryInputSchema = z.object({
  repositoryFullName: z.string().trim().min(1),
  branch: z.string().trim().min(1).optional(),
});

type PrepareRepositoryResult = SandboxPrepareRepositoryResult;

interface RepositoryScope {
  sourceControlProvider: SourceControlProvider;
  repositoryProviders?: Record<string, SourceControlProvider>;
}

// One clone per repository at a time: a duplicate call while the first clone
// is still running would `rm -rf` the half-written checkout underneath it.
const inFlightPreparations = new Map<
  string,
  Promise<PrepareRepositoryResult>
>();

/**
 * The run's source-control scope as stamped at launch. Credentials were
 * minted from the same stamp, so a repository outside it (or under a
 * different provider) would fail authentication rather than clone.
 *
 * The MCP tool is hidden when no checkout scope was stamped, but any holder of
 * the run token can call this mutation directly. The persisted provider map
 * remains the authorization gate for every workspace type.
 */
export async function loadRepositoryScope(
  runId: number,
): Promise<RepositoryScope> {
  const taskRun = await sdk.taskRuns.findFirstById(runId);

  if (!taskRun) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Task run not found' });
  }

  const workspaceType = resolveTaskWorkspace(taskRun.payload).type;
  const repositoryProviders = resolveRepositoryProvidersFromPayload(
    taskRun.payload,
  );

  if (workspaceType === 'no_repositories' && !repositoryProviders) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Repository checkout on demand is unavailable: this Blank slate run was launched without connected source control.',
    });
  }

  if (!repositoryProviders && workspaceType !== 'all_repositories') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Repository checkout on demand is unavailable because this run has no authorized repository scope.',
    });
  }

  return {
    sourceControlProvider: resolveSourceControlProviderFromPayload(
      taskRun.payload,
    ),
    repositoryProviders,
  };
}

/**
 * Resolve which provider a requested repository belongs to. With a stamped
 * provider map the name must be in it (matched case-insensitively, since
 * hosts treat owner/repo that way); without one, the run's primary provider
 * applies.
 */
function resolveRequestedRepositoryProvider(
  repositoryFullName: string,
  scope: RepositoryScope,
): { fullName: string; sourceControlProvider: SourceControlProvider } {
  if (!scope.repositoryProviders) {
    return {
      fullName: repositoryFullName,
      sourceControlProvider: scope.sourceControlProvider,
    };
  }

  const requested = repositoryFullName.toLowerCase();
  const match = Object.entries(scope.repositoryProviders).find(
    ([fullName]) => fullName.toLowerCase() === requested,
  );

  if (!match) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Repository '${repositoryFullName}' is not part of this task's repository set. Use a full name (owner/repo) listed in ${ON_DEMAND_REPOSITORIES_MANIFEST_FILE}.`,
    });
  }

  return { fullName: match[0], sourceControlProvider: match[1] };
}

async function refreshRepositoriesManifest(
  workspaceRoot: string,
  scope: RepositoryScope,
): Promise<string> {
  const repositories = await listOnDemandRepositories(scope);

  return writeRepositoriesManifest({
    workspaceRoot,
    repositories,
    clonedPaths: discoverClonedRepositoryPaths(workspaceRoot, repositories),
  });
}

async function prepareOnDemandRepository({
  runId,
  repositoryFullName,
  branch,
  envVars,
}: {
  runId: number;
  repositoryFullName: string;
  branch?: string;
  envVars: Record<string, string | undefined>;
}): Promise<PrepareRepositoryResult> {
  const scope = await loadRepositoryScope(runId);
  const requested = resolveRequestedRepositoryProvider(
    repositoryFullName,
    scope,
  );
  const repository = await sdk.repositories.findRepository({
    fullName: requested.fullName,
    sourceControlProvider: requested.sourceControlProvider,
  });

  if (!repository) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Repository '${repositoryFullName}' is not an active repository of this deployment. Use a full name (owner/repo) listed in ${ON_DEMAND_REPOSITORIES_MANIFEST_FILE}.`,
    });
  }

  const { workspaceRoot, workspaceManager } = createWorkspaceManager(envVars);
  const repositoryPath = resolveOnDemandRepositoryPath(
    workspaceRoot,
    repository.fullName,
  );

  if (!repositoryPath) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Repository name '${repository.fullName}' resolves outside the workspace root.`,
    });
  }

  // Never re-run preparation on an existing checkout: it would fetch and
  // reset the working tree, discarding whatever the agent changed there.
  if (existsSync(join(repositoryPath, '.git'))) {
    return {
      success: true,
      repositoryFullName: repository.fullName,
      repositoryPath,
      alreadyCheckedOut: true,
      manifestPath: join(workspaceRoot, ON_DEMAND_REPOSITORIES_MANIFEST_FILE),
    };
  }

  const preparedPath = await workspaceManager.prepareRepository(
    repository.fullName,
    branch,
    undefined,
    false,
    false,
    requested.sourceControlProvider === DEFAULT_SOURCE_CONTROL_PROVIDER
      ? {}
      : { sourceControlProvider: requested.sourceControlProvider },
  );
  const manifestPath = await refreshRepositoriesManifest(workspaceRoot, scope);

  return {
    success: true,
    repositoryFullName: repository.fullName,
    repositoryPath: preparedPath,
    alreadyCheckedOut: false,
    manifestPath,
  };
}

/**
 * Check out an authorized active deployment repository into the shared
 * workspace root without running environment setup or touching existing work.
 */
export const prepareRepository = publicProcedure
  .input(prepareRepositoryInputSchema)
  .mutation(async ({ ctx, input }): Promise<PrepareRepositoryResult> => {
    if (ctx.runId === undefined) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Repository checkout requires an active task run',
      });
    }

    // The pre-snapshot scrub removes every source-control credential from
    // the sandbox, so a clone started in that window can only fail.
    if (isCredentialWriteBarrierEngaged()) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Repository checkout is unavailable while the sandbox prepares for a snapshot; retry shortly',
      });
    }

    const key = input.repositoryFullName.toLowerCase();
    const inFlight = inFlightPreparations.get(key);

    if (inFlight) {
      return inFlight;
    }

    const preparation = prepareOnDemandRepository({
      runId: ctx.runId,
      repositoryFullName: input.repositoryFullName,
      branch: input.branch,
      envVars: ctx.taskRuntime?.runtimeEnv ?? process.env,
    }).finally(() => {
      inFlightPreparations.delete(key);
    });

    inFlightPreparations.set(key, preparation);

    return preparation;
  });
