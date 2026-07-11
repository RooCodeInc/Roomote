import { db } from '@roomote/db/server';

import { userOnlyProcedure, router } from '../trpc';

export const githubInstallationsRouter = router({
  findFirst: userOnlyProcedure.query(({ ctx }) => {
    if (!ctx.auth.userId) {
      throw new Error('Invalid authorization token.');
    }

    return db.query.githubInstallations.findFirst();
  }),
});
