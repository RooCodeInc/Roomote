import { z } from 'zod';
import { sourceControlProviderSchema } from '@roomote/types';

import { authenticatedProcedure, router } from '../trpc';

import { listRepositories, findRepository } from '../lib/repositories';

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
});
