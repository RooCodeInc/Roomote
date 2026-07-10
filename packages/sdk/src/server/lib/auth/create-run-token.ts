import { z } from 'zod';

import type { AuthTokenContext } from '@roomote/types';
import * as Auth from '@roomote/auth';
import { db, taskRuns, eq } from '@roomote/db/server';

export const createRunTokenInputSchema = Auth.createRunTokenOptionsSchema.omit({
  userId: true,
});

export const createRunToken = async (
  auth: AuthTokenContext,
  input: z.infer<typeof createRunTokenInputSchema>,
) => {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
  });

  if (!taskRun) {
    console.error(`[createRunToken] Task run ${input.runId} not found`);
    throw new Error(`Task run ${input.runId} not found`);
  }

  // Jobs without a human driver are tokenized as the deployment service
  // principal rather than borrowing an arbitrary user's identity.
  return Auth.createRunToken({
    ...input,
    userId: taskRun.actingUserId ?? null,
  });
};
