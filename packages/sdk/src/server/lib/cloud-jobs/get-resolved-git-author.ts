import { db, cloudJobs, eq } from '@roomote/db/server';

import { resolveGitAuthor } from './dequeue-helpers';

export async function getResolvedGitAuthor(cloudJobId: number) {
  return db.transaction(async (tx) => {
    const cloudJob = await tx.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, cloudJobId),
    });

    if (!cloudJob) {
      throw new Error(`Cloud job not found: ${cloudJobId}`);
    }

    return resolveGitAuthor(tx, cloudJob);
  });
}
