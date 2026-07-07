import { nonJobProcedure, router } from '../trpc';

import {
  me,
  createJobTokenInputSchema,
  createJobToken,
  createAuthTokenInputSchema,
  createAuthToken,
} from '../lib/auth';

export const authRouter = router({
  me: nonJobProcedure.query(({ ctx }) => me(ctx.auth)),
  createJobToken: nonJobProcedure
    .input(createJobTokenInputSchema)
    .mutation(({ ctx, input }) => createJobToken(ctx.auth, input)),
  createAuthToken: nonJobProcedure
    .input(createAuthTokenInputSchema)
    .mutation(({ ctx, input }) => createAuthToken(ctx.auth, input)),
});
