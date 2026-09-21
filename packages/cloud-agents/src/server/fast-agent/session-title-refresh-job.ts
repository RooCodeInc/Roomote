import { Queue } from 'bullmq';

import { getRedis } from '@roomote/redis';

import {
  refreshFastAgentSessionTitle,
  refreshTaskSessionTitle,
  type SessionTitleRefreshResult,
} from './fast-agent-title';

const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';
const RETRY_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 15_000;

export const SESSION_TITLE_REFRESH_JOB = 'SessionTitleRefresh';

export type SessionTitleRefreshJob =
  | {
      kind: 'fast';
      fastConversationId: string;
      userId: string;
      checkpoint: number;
    }
  | {
      kind: 'task';
      taskId: string;
      userId?: string;
      mode: 'checkpoint' | 'final';
      checkpoint: number;
    };

type SessionTitleRefreshJobInput =
  | Omit<Extract<SessionTitleRefreshJob, { kind: 'fast' }>, 'checkpoint'>
  | Omit<Extract<SessionTitleRefreshJob, { kind: 'task' }>, 'checkpoint'>;

let queue: Queue | null = null;

function getQueue(): Queue {
  queue ??= new Queue(SCHEDULED_JOBS_QUEUE, { connection: getRedis() });
  return queue;
}

function jobIdFor(input: SessionTitleRefreshJob): string {
  return input.kind === 'fast'
    ? `session-title-refresh-fast-${input.fastConversationId}-${input.checkpoint}`
    : `session-title-refresh-task-${input.taskId}-${input.mode}-${input.checkpoint}`;
}

async function enqueueRetry(
  input: SessionTitleRefreshJobInput,
  result: SessionTitleRefreshResult,
): Promise<boolean> {
  if (result.status !== 'failed') return false;

  const job = {
    ...input,
    checkpoint: result.checkpoint ?? 0,
  } as SessionTitleRefreshJob;
  try {
    await getQueue().add(SESSION_TITLE_REFRESH_JOB, job, {
      jobId: jobIdFor(job),
      attempts: RETRY_ATTEMPTS,
      backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 24 * 3_600 },
    });
    return true;
  } catch (error) {
    console.error(
      `[SessionTitleRefresh] Failed to enqueue retry: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export async function refreshFastAgentSessionTitleWithRetry(input: {
  sessionId: string;
  userId: string;
}): Promise<SessionTitleRefreshResult> {
  const result = await refreshFastAgentSessionTitle(input);
  await enqueueRetry(
    {
      kind: 'fast',
      fastConversationId: input.sessionId,
      userId: input.userId,
    },
    result,
  );
  return result;
}

export async function refreshTaskSessionTitleWithRetry(input: {
  taskId: string;
  userId?: string;
  mode: 'checkpoint' | 'final';
}): Promise<SessionTitleRefreshResult> {
  const result = await refreshTaskSessionTitle(input);
  await enqueueRetry({ kind: 'task', ...input }, result);
  return result;
}

export async function processSessionTitleRefreshJob(
  job: SessionTitleRefreshJob,
): Promise<void> {
  const result =
    job.kind === 'fast'
      ? await refreshFastAgentSessionTitle({
          sessionId: job.fastConversationId,
          userId: job.userId,
        })
      : await refreshTaskSessionTitle({
          taskId: job.taskId,
          userId: job.userId,
          mode: job.mode,
        });

  if (result.status === 'failed') {
    throw new Error(
      `Session title refresh failed (${result.reason}): ${result.message}`,
    );
  }
}
