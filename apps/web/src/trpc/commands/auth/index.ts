import { createPublicAuthToken, createJobToken } from '@roomote/auth';
import { db, eq, taskRuns } from '@roomote/db/server';

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

  // Run access is deployment-scoped: any signed-in member may mint a sandbox
  // token for any run; the token is stamped with the requesting user.
  const job = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.cloudJobId),
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
