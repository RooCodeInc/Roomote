import { createPublicAuthToken, createRunToken } from '@roomote/auth';
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
  input: { runId: number; timeoutMs?: number },
): Promise<string | undefined> {
  const { userId } = auth;

  // Run access is deployment-scoped: any signed-in member may mint a sandbox
  // token for any run; the token is stamped with the requesting user.
  const job = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: { id: true },
  });

  if (!job) {
    return undefined;
  }

  return createRunToken({
    runId: input.runId,
    userId,
    // Default/cap align with SANDBOX_TIMEOUT_MS / MAX_RUN_TOKEN_TIMEOUT_MS.
    timeoutMs: input.timeoutMs ?? 5 * 60 * 60 * 1000,
  });
}
