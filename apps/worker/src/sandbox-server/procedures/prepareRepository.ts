import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { sdk } from '@roomote/sdk/client';
import type { SandboxPrepareRepositoryResult } from '@roomote/sdk/sandbox-router';
import { DEFAULT_SOURCE_CONTROL_PROVIDER } from '@roomote/types';

import { listOnDemandRepositories } from '../../commands/setup/workspace/list-on-demand-repositories';
import { createWorkspaceManager } from '../../commands/setup/workspace/shared';
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

// One clone per repository at a time: a duplicate call while the first clone
// is still running would `rm -rf` the half-written checkout underneath it.
const inFlightPreparations = new Map<
  string,
  Promise<PrepareRepositoryResult>
>();

async function refreshRepositoriesManifest(
  workspaceRoot: string,
): Promise<string> {
  const repositories = await listOnDemandRepositories({});

  return writeRepositoriesManifest({
    workspaceRoot,
    repositories,
    clonedPaths: discoverClonedRepositoryPaths(workspaceRoot, repositories),
  });
}

async function prepareOnDemandRepository({
  repositoryFullName,
  branch,
  envVars,
}: {
  repositoryFullName: string;
  branch?: string;
  envVars: Record<string, string | undefined>;
}): Promise<PrepareRepositoryResult> {
  const repository = await sdk.repositories.findRepository({
    fullName: repositoryFullName,
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
    repository.sourceControlProvider === DEFAULT_SOURCE_CONTROL_PROVIDER
      ? {}
      : { sourceControlProvider: repository.sourceControlProvider },
  );
  const manifestPath = await refreshRepositoriesManifest(workspaceRoot);

  return {
    success: true,
    repositoryFullName: repository.fullName,
    repositoryPath: preparedPath,
    alreadyCheckedOut: false,
    manifestPath,
  };
}

/**
 * Check out one of the deployment's repositories into the shared workspace
 * root. All-repositories workspaces no longer clone every repository during
 * setup; the agent calls this (through the `clone_repository` MCP tool) for
 * the repositories the task actually needs.
 */
export const prepareRepository = publicProcedure
  .input(prepareRepositoryInputSchema)
  .mutation(async ({ ctx, input }): Promise<PrepareRepositoryResult> => {
    const key = input.repositoryFullName.toLowerCase();
    const inFlight = inFlightPreparations.get(key);

    if (inFlight) {
      return inFlight;
    }

    const preparation = prepareOnDemandRepository({
      repositoryFullName: input.repositoryFullName,
      branch: input.branch,
      envVars: ctx.taskRuntime?.runtimeEnv ?? process.env,
    }).finally(() => {
      inFlightPreparations.delete(key);
    });

    inFlightPreparations.set(key, preparation);

    return preparation;
  });
