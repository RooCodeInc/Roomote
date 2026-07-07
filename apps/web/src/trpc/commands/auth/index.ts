import { createPublicAuthToken, createJobToken } from '@roomote/auth';
import { db, cloudJobs, eq } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

export async function getAuthTokenCommand(
  auth: UserAuthSuccess,
  input: { timeoutMs?: number },
): Promise<string> {
  const { userId } = auth;

  return createPublicAuthToken({
    userId,
    timeoutMs: input.timeoutMs,
  });
}

export async function getSandboxAuthTokenCommand(
  auth: UserAuthSuccess,
  input: { cloudJobId: number; timeoutMs?: number },
): Promise<string | undefined> {
  const { userId } = auth;

  const job = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, input.cloudJobId),
    columns: { id: true },
  });

  if (!job) {
    return undefined;
  }

  return createJobToken({
    cloudJobId: input.cloudJobId,
    userId,
    timeoutMs: input.timeoutMs ?? 6 * 60 * 60 * 1000,
  });
}
