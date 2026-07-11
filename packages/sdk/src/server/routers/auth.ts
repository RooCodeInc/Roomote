import { userOnlyProcedure, router } from '../trpc';

import {
  me,
  createRunTokenInputSchema,
  createRunToken,
  createAuthTokenInputSchema,
  createAuthToken,
} from '../lib/auth';

export const authRouter = router({
  me: userOnlyProcedure.query(({ ctx }) => me(ctx.auth)),
  createRunToken: userOnlyProcedure
    .input(createRunTokenInputSchema)
    .mutation(({ ctx, input }) => createRunToken(ctx.auth, input)),
  createAuthToken: userOnlyProcedure
    .input(createAuthTokenInputSchema)
    .mutation(({ ctx, input }) => createAuthToken(ctx.auth, input)),
});
