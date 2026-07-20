import { z } from 'zod';
import { sourceControlProviderSchema } from '@roomote/types';

import { authenticatedProcedure, router } from '../trpc';

import {
  listRepositories,
  findRepository,
  updateRepositoryDefaultBranch,
} from '../lib/repositories';

export const repositoriesRouter = router({
  listRepositories: authenticatedProcedure
    .input(
      z
        .object({
          sourceControlProvider: sourceControlProviderSchema.optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listRepositories(ctx.auth, input)),
  findRepository: authenticatedProcedure
    .input(
      z.union([
        z.string(),
        z.object({
          fullName: z.string(),
          sourceControlProvider: sourceControlProviderSchema.optional(),
        }),
      ]),
    )
    .query(({ ctx, input }) =>
      typeof input === 'string'
        ? findRepository(ctx.auth, input)
        : findRepository(ctx.auth, input.fullName, {
            sourceControlProvider: input.sourceControlProvider,
          }),
    ),
  reportDefaultBranch: authenticatedProcedure
    .input(
      z.object({
        repositoryId: z.string().min(1),
        // Sanity bounds only: the value is the branch git itself resolved
        // from origin/HEAD on the worker, not free-form user input.
        defaultBranch: z
          .string()
          .min(1)
          .max(512)
          .regex(/^[^\s]+$/, 'Branch names cannot contain whitespace'),
      }),
    )
    .mutation(({ ctx, input }) =>
      updateRepositoryDefaultBranch(ctx.auth, input),
    ),
});
