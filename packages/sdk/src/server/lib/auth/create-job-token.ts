import { z } from 'zod';

import type { AuthTokenContext } from '@roomote/types';
import * as Auth from '@roomote/auth';
import { db, cloudJobs, eq } from '@roomote/db/server';

export const createJobTokenInputSchema = Auth.createJobTokenOptionsSchema.omit({
  userId: true,
});

export const createJobToken = async (
  auth: AuthTokenContext,
  input: z.infer<typeof createJobTokenInputSchema>,
) => {
  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, input.cloudJobId),
  });

  if (!cloudJob) {
    console.error(`[createJobToken] Cloud job ${input.cloudJobId} not found`);
    throw new Error(`Cloud job ${input.cloudJobId} not found`);
  }

  // Jobs without a human driver are tokenized as the deployment service
  // principal rather than borrowing an arbitrary user's identity.
  return Auth.createJobToken({ ...input, userId: cloudJob.userId ?? null });
};
