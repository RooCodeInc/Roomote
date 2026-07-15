import { TRPCClientError } from '@trpc/client';
import { withSandboxServerRpcClient } from '@roomote/sdk/server';
import {
  and,
  cancelTaskRunDirect,
  db,
  eq,
  isNull,
  taskRuns,
} from '@roomote/db/server';
import { type RunStatus, isExitedRunStatus } from '@roomote/types';

interface StopTaskRun {
  id: number;
  status: RunStatus;
  sandboxServerUrl: string | null;
  actingUserId: string | null;
}

/**
 * Attribution for the user stop, forwarded to the sandbox so the transcript
 * gets a visible `task_cancelled` marker naming who stopped the task.
 */
interface StopTaskAttribution {
  name?: string;
  source?: string;
}

type StopTaskRunResult =
  | { success: true; mode: 'sandbox_stop' | 'direct_cancel' }
  | { success: false; error: string; statusCode: 404 | 409 | 502 };

type StopTaskRunResolution =
  | { kind: 'not_found' }
  | { kind: 'terminal'; status: RunStatus }
  | { kind: 'no_sandbox' }
  | { kind: 'sandbox'; run: StopTaskRun & { sandboxServerUrl: string } };

async function findCurrentStopTaskRun(
  runId: number,
): Promise<StopTaskRun | null> {
  return (
    (await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
      columns: {
        id: true,
        status: true,
        sandboxServerUrl: true,
        actingUserId: true,
      },
    })) ?? null
  );
}

/**
 * Persist the stop request on the task run row before the cancel is carried
 * out. If the sandbox dies before the row reaches a terminal state, recovery
 * sweeps use this to finalize the run as canceled instead of misreporting the
 * deliberate stop as a runtime failure. Keeps the earliest request time.
 */
async function markCancelRequested(runId: number): Promise<void> {
  await db
    .update(taskRuns)
    .set({ cancelRequestedAt: new Date() })
    .where(and(eq(taskRuns.id, runId), isNull(taskRuns.cancelRequestedAt)));
}

async function cancelTaskRunBeforeSandbox(runId: number): Promise<boolean> {
  // Shared @roomote/db helper (also used by the work-item launch surfaces to
  // clean up an orphaned run after a lost fenced finalize): guarded
  // pre-sandbox cancel + task-state re-derive + parallel-count close.
  return cancelTaskRunDirect({ runId });
}

function createTaskNotFoundResult(): StopTaskRunResult {
  return {
    success: false,
    statusCode: 404,
    error: 'Task not found',
  };
}

function createTaskNotActiveResult(status: RunStatus): StopTaskRunResult {
  return {
    success: false,
    statusCode: 409,
    error: `Task is not active (status: ${status})`,
  };
}

function createNoSandboxResult(): StopTaskRunResult {
  return {
    success: false,
    statusCode: 409,
    error: 'Task has no active sandbox. The worker may still be booting.',
  };
}

function resolveStopTaskRun(run: StopTaskRun | null): StopTaskRunResolution {
  if (!run) {
    return { kind: 'not_found' };
  }

  if (isExitedRunStatus(run.status)) {
    return { kind: 'terminal', status: run.status };
  }

  if (!run.sandboxServerUrl) {
    return { kind: 'no_sandbox' };
  }

  return {
    kind: 'sandbox',
    run: {
      ...run,
      sandboxServerUrl: run.sandboxServerUrl,
    },
  };
}

function stopTaskResolutionToResult(
  resolution: Exclude<StopTaskRunResolution, { kind: 'sandbox' }>,
): StopTaskRunResult {
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
  runId: number,
): Promise<StopTaskRunResolution> {
  return resolveStopTaskRun(await findCurrentStopTaskRun(runId));
}

async function stopTaskSandboxRun(params: {
  run: StopTaskRun & { sandboxServerUrl: string };
  authUserId?: string | null;
  cancelledBy?: StopTaskAttribution;
  /**
   * When true, the worker cancels the turn and shuts the sandbox down. Soft
   * stops omit this so the UI stop path can leave a resumable session.
   */
  terminate?: boolean;
}): Promise<StopTaskRunResult> {
  const { run, authUserId, cancelledBy, terminate } = params;
  // Prefer the caller's auth identity, then the live run actor. Both may be
  // null for chat-started / automation runs that still only have a deployment
  // service principal; createRunToken accepts that and mints a principal token
  // so provider cancel buttons (Slack/Telegram) can stop active sandboxes
  // without a human user claim on the run row.
  const tokenUserId = authUserId ?? run.actingUserId ?? null;

  await markCancelRequested(run.id);

  try {
    await withSandboxServerRpcClient({
      runId: run.id,
      userId: tokenUserId,
      sandboxServerUrl: run.sandboxServerUrl,
      call: (client) =>
        client.commands.cancelTask.mutate({
          ...(cancelledBy ? { cancelledBy } : {}),
          ...(terminate ? { terminate: true } : {}),
        }),
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

export async function stopTaskRun(params: {
  run: StopTaskRun;
  authUserId?: string | null;
  allowDirectCancelWithoutSandbox?: boolean;
  cancelledBy?: StopTaskAttribution;
  /**
   * Terminal cancel for provider affordances (Slack/Telegram Cancel). Soft
   * web/API stop omits this so the sandbox stays resumable.
   */
  terminate?: boolean;
}): Promise<StopTaskRunResult> {
  const {
    run,
    authUserId,
    allowDirectCancelWithoutSandbox,
    cancelledBy,
    terminate,
  } = params;

  const initialResolution = resolveStopTaskRun(run);

  if (initialResolution.kind === 'terminal') {
    return createTaskNotActiveResult(initialResolution.status);
  }

  if (initialResolution.kind === 'sandbox') {
    return await stopTaskSandboxRun({
      run: initialResolution.run,
      authUserId,
      cancelledBy,
      terminate,
    });
  }

  if (!allowDirectCancelWithoutSandbox) {
    return createNoSandboxResult();
  }

  const refreshedResolution = await readCurrentStopTaskResolution(run.id);

  if (refreshedResolution.kind === 'sandbox') {
    return await stopTaskSandboxRun({
      run: refreshedResolution.run,
      authUserId,
      cancelledBy,
      terminate,
    });
  }

  if (refreshedResolution.kind !== 'no_sandbox') {
    return stopTaskResolutionToResult(refreshedResolution);
  }

  if (await cancelTaskRunBeforeSandbox(run.id)) {
    return { success: true, mode: 'direct_cancel' };
  }

  const racedResolution = await readCurrentStopTaskResolution(run.id);

  if (racedResolution.kind === 'sandbox') {
    return await stopTaskSandboxRun({
      run: racedResolution.run,
      authUserId,
      cancelledBy,
      terminate,
    });
  }

  return stopTaskResolutionToResult(racedResolution);
}
