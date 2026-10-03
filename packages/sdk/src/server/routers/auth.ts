import { userOnlyProcedure, router } from '../trpc';

import { me, createAuthTokenInputSchema, createAuthToken } from '../lib/auth';

export const authRouter = router({
  me: userOnlyProcedure.query(({ ctx }) => me(ctx.auth)),
  createAuthToken: userOnlyProcedure
    .input(createAuthTokenInputSchema)
    .mutation(({ ctx, input }) => createAuthToken(ctx.auth, input)),
});
