import { createPublicAuthToken, createRunToken } from '@roomote/auth';
import { db, eq, taskRuns } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { requireTaskAccess } from '@/lib/server/custom-automation-task-access';

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

  const job = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: { taskId: true },
  });

  if (!job) {
    return undefined;
  }

  await requireTaskAccess(auth, job.taskId);

  return createRunToken({
    runId: input.runId,
    userId,
    // Default/cap align with SANDBOX_TIMEOUT_MS / MAX_RUN_TOKEN_TIMEOUT_MS.
    timeoutMs: input.timeoutMs ?? 5 * 60 * 60 * 1000,
  });
}
