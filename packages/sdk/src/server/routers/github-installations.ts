import { db } from '@roomote/db/server';

import { nonJobProcedure, router } from '../trpc';

export const githubInstallationsRouter = router({
  findFirst: nonJobProcedure.query(({ ctx }) => {
    if (!ctx.auth.userId) {
      throw new Error('Invalid authorization token.');
    }

    return db.query.githubInstallations.findFirst();
  }),
});
