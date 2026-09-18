import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { SandboxListRepositoriesResult } from '@roomote/sdk/sandbox-router';
import {
  LIST_REPOSITORIES_DEFAULT_LIMIT,
  LIST_REPOSITORIES_MAX_LIMIT,
} from '@roomote/types';

import { listOnDemandRepositories } from '../../commands/setup/workspace/list-on-demand-repositories';
import { createWorkspaceManager } from '../../commands/setup/workspace/shared';
import {
  discoverClonedRepositoryPaths,
  pageOnDemandRepositories,
} from '../../workspace/on-demand-repositories';
import { publicProcedure } from '../trpc';
import { loadRepositoryScope } from './prepareRepository';

const listRepositoriesInputSchema = z
  .object({
    query: z.string().trim().optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(LIST_REPOSITORIES_MAX_LIMIT)
      .optional(),
  })
  .optional();

/**
 * List the repositories this run may check out, read live so a repository
 * connected after the sandbox started is visible. Shares `prepareRepository`'s
 * scope gate: the result never names a repository the run cannot clone.
 */
export const listRepositories = publicProcedure
  .input(listRepositoriesInputSchema)
  .query(async ({ ctx, input }): Promise<SandboxListRepositoriesResult> => {
    if (ctx.runId === undefined) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Repository listing requires an active task run',
      });
    }

    const scope = await loadRepositoryScope(ctx.runId);
    const repositories = await listOnDemandRepositories(scope);
    const { workspaceRoot } = createWorkspaceManager(
      ctx.taskRuntime?.runtimeEnv ?? process.env,
    );

    return {
      success: true,
      ...pageOnDemandRepositories({
        repositories,
        clonedPaths: discoverClonedRepositoryPaths(workspaceRoot, repositories),
        query: input?.query,
        offset: input?.offset,
        limit: input?.limit ?? LIST_REPOSITORIES_DEFAULT_LIMIT,
      }),
    };
  });
