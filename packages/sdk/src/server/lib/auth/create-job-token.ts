import { z } from 'zod';

import type { AuthTokenContext } from '@roomote/types';
import * as Auth from '@roomote/auth';
import { db, cloudJobs, eq } from '@roomote/db/server';
import { resolveUserIdForCloudJob } from '@roomote/cloud-agents/server';

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

  const userId = await resolveUserIdForCloudJob(cloudJob);

  if (!userId) {
    console.error(
      `[createJobToken] Unable to determine user to authorize for cloud job ${JSON.stringify(cloudJob)}`,
    );

    throw new Error('Unable to determine user to authorize for cloud job');
  }

  return Auth.createJobToken({ ...input, userId });
};
