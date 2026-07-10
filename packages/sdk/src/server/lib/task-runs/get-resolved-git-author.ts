import { db, taskRuns, eq } from '@roomote/db/server';

import { resolveGitAuthor } from './dequeue-helpers';

export async function getResolvedGitAuthor(runId: number) {
  return db.transaction(async (tx) => {
    const taskRun = await tx.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
    });

    if (!taskRun) {
      throw new Error(`Task run not found: ${runId}`);
    }

    return resolveGitAuthor(tx, taskRun);
  });
}
