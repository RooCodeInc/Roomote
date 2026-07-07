import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  authenticatedProcedure,
  isJobToken,
  nonJobProcedure,
  router,
} from '../trpc';

import {
  findEnvironment,
  listEnvironments,
  updateSnapshotStatus,
} from '../lib/environments';

export const environmentsRouter = router({
  list: nonJobProcedure.query(({ ctx }) => listEnvironments(ctx.auth)),
  byId: nonJobProcedure
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
      if (!isJobToken(ctx.auth)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This endpoint is only available to job tokens',
        });
      }

      return updateSnapshotStatus(ctx.auth, input);
    }),
});
