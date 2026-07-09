import { TRPCClientError } from '@trpc/client';
import { withSandboxServerRpcClient } from '@roomote/sdk/server';
import {
  and,
  db,
  eq,
  inArray,
  isNull,
  markTaskStartParallelCountEndedAt,
  not,
  syncTaskStateFromRuns,
  taskRuns,
} from '@roomote/db/server';
import {
  CloudTaskStatus,
  exitedCloudTaskStatuses,
  isExitedCloudTaskStatus,
} from '@roomote/types';

interface StopTaskJob {
  id: number;
  status: CloudTaskStatus;
  sandboxServerUrl: string | null;
  actingUserId: string | null;
}

type StopTaskJobResult =
  | { success: true; mode: 'sandbox_stop' | 'direct_cancel' }
  | { success: false; error: string; statusCode: 403 | 404 | 409 | 502 };

type StopTaskJobResolution =
  | { kind: 'not_found' }
  | { kind: 'terminal'; status: CloudTaskStatus }
  | { kind: 'no_sandbox' }
  | { kind: 'sandbox'; job: StopTaskJob & { sandboxServerUrl: string } };

async function findCurrentStopTaskJob(
  jobId: number,
): Promise<StopTaskJob | null> {
  return (
    (await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, jobId),
      columns: {
        id: true,
        status: true,
        sandboxServerUrl: true,
        actingUserId: true,
      },
    })) ?? null
  );
}

async function cancelTaskJobDirect(jobId: number): Promise<boolean> {
  const endedAt = new Date();

  const [updatedJob] = await db.transaction(async (tx) => {
    const [job] = await tx
      .update(taskRuns)
      .set({
        status: CloudTaskStatus.Canceled,
        canceledAt: endedAt,
      })
      .where(
        and(
          eq(taskRuns.id, jobId),
          isNull(taskRuns.sandboxServerUrl),
          not(
            inArray(
              taskRuns.status,
              exitedCloudTaskStatuses as unknown as CloudTaskStatus[],
            ),
          ),
        ),
      )
      .returning({ id: taskRuns.id, taskId: taskRuns.taskId });

    if (!job) {
      return [];
    }

    // Derive the durable task state from all its runs after this direct cancel,
    // so a still-running or already-completed sibling is respected.
    await syncTaskStateFromRuns(tx, job.taskId);

    await markTaskStartParallelCountEndedAt(tx, {
      runId: jobId,
      endedAt,
    });

    return [true];
  });

  return Boolean(updatedJob);
}

function createTaskNotFoundResult(): StopTaskJobResult {
  return {
    success: false,
    statusCode: 404,
    error: 'Task not found',
  };
}

function createTaskNotActiveResult(status: CloudTaskStatus): StopTaskJobResult {
  return {
    success: false,
    statusCode: 409,
    error: `Task is not active (status: ${status})`,
  };
}

function createNoSandboxResult(): StopTaskJobResult {
  return {
    success: false,
    statusCode: 409,
    error: 'Task has no active sandbox. The worker may still be booting.',
  };
}

function resolveStopTaskJob(job: StopTaskJob | null): StopTaskJobResolution {
  if (!job) {
    return { kind: 'not_found' };
  }

  if (isExitedCloudTaskStatus(job.status)) {
    return { kind: 'terminal', status: job.status };
  }

  if (!job.sandboxServerUrl) {
    return { kind: 'no_sandbox' };
  }

  return {
    kind: 'sandbox',
    job: {
      ...job,
      sandboxServerUrl: job.sandboxServerUrl,
    },
  };
}

function stopTaskResolutionToResult(
  resolution: Exclude<StopTaskJobResolution, { kind: 'sandbox' }>,
): StopTaskJobResult {
  switch (resolution.kind) {
    case 'not_found':
      return createTaskNotFoundResult();
    case 'terminal':
      return createTaskNotActiveResult(resolution.status);
    case 'no_sandbox':
      return createNoSandboxResult();
  }
}

async function readCurrentStopTaskResolution(
  jobId: number,
): Promise<StopTaskJobResolution> {
  return resolveStopTaskJob(await findCurrentStopTaskJob(jobId));
}

async function stopTaskSandboxJob(params: {
  job: StopTaskJob & { sandboxServerUrl: string };
  authUserId?: string | null;
}): Promise<StopTaskJobResult> {
  const { job, authUserId } = params;
  const tokenUserId = authUserId ?? job.actingUserId;

  if (!tokenUserId) {
    return {
      success: false,
      statusCode: 403,
      error: 'User context required to stop the active sandbox task',
    };
  }

  try {
    await withSandboxServerRpcClient({
      cloudJobId: job.id,
      userId: tokenUserId,
      sandboxServerUrl: job.sandboxServerUrl,
      call: (client) => client.commands.cancelTask.mutate(),
    });

    return { success: true, mode: 'sandbox_stop' };
  } catch (error) {
    if (error instanceof TRPCClientError) {
      return {
        success: false,
        statusCode: 502,
        error: `Sandbox error: ${error.message}`,
      };
    }

    throw error;
  }
}

export async function stopTaskJob(params: {
  job: StopTaskJob;
  authUserId?: string | null;
  allowDirectCancelWithoutSandbox?: boolean;
}): Promise<StopTaskJobResult> {
  const { job, authUserId, allowDirectCancelWithoutSandbox } = params;

  const initialResolution = resolveStopTaskJob(job);

  if (initialResolution.kind === 'terminal') {
    return createTaskNotActiveResult(initialResolution.status);
  }

  if (initialResolution.kind === 'sandbox') {
    return await stopTaskSandboxJob({
      job: initialResolution.job,
      authUserId,
    });
  }

  if (!allowDirectCancelWithoutSandbox) {
    return createNoSandboxResult();
  }

  const refreshedResolution = await readCurrentStopTaskResolution(job.id);

  if (refreshedResolution.kind === 'sandbox') {
    return await stopTaskSandboxJob({
      job: refreshedResolution.job,
      authUserId,
    });
  }

  if (refreshedResolution.kind !== 'no_sandbox') {
    return stopTaskResolutionToResult(refreshedResolution);
  }

  if (await cancelTaskJobDirect(job.id)) {
    return { success: true, mode: 'direct_cancel' };
  }

  const racedResolution = await readCurrentStopTaskResolution(job.id);

  if (racedResolution.kind === 'sandbox') {
    return await stopTaskSandboxJob({
      job: racedResolution.job,
      authUserId,
    });
  }

  return stopTaskResolutionToResult(racedResolution);
}
