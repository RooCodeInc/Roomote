import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  authenticatedProcedure,
  isRunToken,
  userOnlyProcedure,
  router,
} from '../trpc';

import {
  findEnvironment,
  listEnvironments,
  updateSnapshotStatus,
} from '../lib/environments';

export const environmentsRouter = router({
  list: userOnlyProcedure.query(({ ctx }) => listEnvironments(ctx.auth)),
  byId: userOnlyProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => findEnvironment(ctx.auth, input.id)),
  findEnvironment: authenticatedProcedure
    .input(z.string())
    .query(({ ctx, input }) => findEnvironment(ctx.auth, input)),
  updateSnapshotStatus: authenticatedProcedure
    .input(
      z.object({
        environmentId: z.string(),
        snapshotStatus: z.enum(['failed']),
      }),
    )
    .mutation(({ ctx, input }) => {
      if (!isRunToken(ctx.auth)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This endpoint is only available to run tokens',
        });
      }

      return updateSnapshotStatus(ctx.auth, input);
    }),
});
