import {
  CloudTaskStatus,
  CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY,
  type ConflictResolutionSummary,
} from '@roomote/types';
import { type Run, sdk } from '@roomote/sdk/client';

import { ExecutionError } from '../../command-executor';
import type { HarnessLogger } from '../../logging';
import { captureWorkerException } from '../../monitoring/sentry';
import type { WorkerRuntimeContext } from '../../monitoring/runtime-context';
import type { RunTaskCallbacks, RunTaskContext } from '../../run-task';

const MAX_PERSISTED_ERROR_DETAILS_LENGTH = 8_000;
const MAX_PERSISTED_ERROR_COMMAND_LENGTH = 2_000;
const MAX_PERSISTED_ERROR_SUMMARY_LENGTH = 1_000;

function truncateTail(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `... (truncated)\n${value.slice(-maxLength)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatExecutionErrorDetails(error: ExecutionError): string {
  const { result } = error;
  const headerParts = [
    truncateTail(result.command.run, MAX_PERSISTED_ERROR_COMMAND_LENGTH),
  ];

  if (result.exitCode !== undefined) {
    headerParts.push(`\nexit code -> ${result.exitCode}`);
  }

  if (result.error) {
    headerParts.push(
      `\nerror -> ${truncateTail(result.error, MAX_PERSISTED_ERROR_SUMMARY_LENGTH)}`,
    );
  }

  const header = headerParts.join('\n');
  const outputEntries = [
    result.stdout ? (['stdout', result.stdout] as const) : undefined,
    result.stderr ? (['stderr', result.stderr] as const) : undefined,
  ].filter((entry): entry is readonly ['stdout' | 'stderr', string] =>
    Boolean(entry),
  );

  if (outputEntries.length === 0) {
    return header;
  }

  const outputBudget = Math.max(
    0,
    MAX_PERSISTED_ERROR_DETAILS_LENGTH - header.length,
  );
  const perOutputBudget = Math.max(
    0,
    Math.floor(outputBudget / outputEntries.length) - 16,
  );
  const outputParts = outputEntries.map(
    ([name, value]) => `\n${name} -> ${truncateTail(value, perOutputBudget)}`,
  );

  return `${header}${outputParts.join('\n')}`;
}

function describeJobFailure(error: unknown): string {
  if (error instanceof ExecutionError) {
    return formatExecutionErrorDetails(error);
  }

  return describeError(error);
}

function buildWorkerExceptionContext(params: {
  error: unknown;
  cloudJob: Run | undefined;
}): WorkerRuntimeContext {
  const { error, cloudJob } = params;
  const context: WorkerRuntimeContext = {
    cloudJobId: cloudJob?.id ?? null,
    stage: 'handleJobError',
    ...(cloudJob?.taskId ? { taskId: cloudJob.taskId } : {}),
  };

  if (error instanceof ExecutionError) {
    context.commandName = error.result.command.name;
    context.commandRun = error.result.command.run;
    context.exitCode = error.result.exitCode ?? null;
    context.commandDurationMs = error.result.duration;
    context.commandDiagnostics = formatExecutionErrorDetails(error);
  }

  return context;
}

function createLifecycleError(step: string, error: unknown): Error {
  const message = `${step}: ${describeError(error)}`;
  return error instanceof Error
    ? new Error(message, { cause: error })
    : new Error(message);
}

export async function finalizeJob({
  result,
  cloudJob,
  callbacks,
  context,
}: {
  result: {
    status: CloudTaskStatus;
    error?: string;
  };
  cloudJob: Run;
  logger: HarnessLogger;
  callbacks: RunTaskCallbacks;
  context: RunTaskContext;
}): Promise<void> {
  const { status, error } = result;

  const conflictResolutionSummary = context.conflictResolutionSummary as
    | ConflictResolutionSummary
    | undefined;

  if (conflictResolutionSummary) {
    const existingResult =
      cloudJob.result &&
      typeof cloudJob.result === 'object' &&
      !Array.isArray(cloudJob.result)
        ? (cloudJob.result as Record<string, unknown>)
        : {};

    const nextResult = {
      ...existingResult,
      [CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY]: conflictResolutionSummary,
    };

    try {
      await sdk.cloudJobs.update({ id: cloudJob.id, result: nextResult });
    } catch (error) {
      throw createLifecycleError(
        `cloudJobs.update(result) failed during finalization for cloud job ${cloudJob.id}`,
        error,
      );
    }
    cloudJob.result = nextResult;
  }

  try {
    await sdk.cloudJobs.done({
      id: cloudJob.id,
      status: status as
        | CloudTaskStatus.Completed
        | CloudTaskStatus.Failed
        | CloudTaskStatus.Canceled
        | CloudTaskStatus.Idle,
      ...(error && { error }),
    });
  } catch (doneError) {
    throw createLifecycleError(
      `cloudJobs.done(${status}) failed during finalization for cloud job ${cloudJob.id}`,
      doneError,
    );
  }

  try {
    await callbacks.onExit?.(cloudJob, status, context);
  } catch (exitError) {
    throw createLifecycleError(
      `callbacks.onExit failed during finalization for cloud job ${cloudJob.id}`,
      exitError,
    );
  }

  if (status !== CloudTaskStatus.Completed) {
    console.error(`Job exited with status: ${status}`);
  }
}

export async function handleJobError({
  error,
  cloudJob,
  callbacks,
  context,
}: {
  error: unknown;
  cloudJob: Run | undefined;
  logger: HarnessLogger | undefined;
  callbacks: RunTaskCallbacks;
  context: RunTaskContext;
}): Promise<'failed'> {
  const message = describeJobFailure(error);

  captureWorkerException(
    error,
    buildWorkerExceptionContext({ error, cloudJob }),
  );

  if (cloudJob) {
    await sdk.cloudJobs.done({
      id: cloudJob.id,
      status: CloudTaskStatus.Failed,
      error: message,
    });

    await callbacks.onExit?.(cloudJob, CloudTaskStatus.Failed, context);
  }

  console.error(`❌ Job ${cloudJob?.id ?? '<unknown>'} failed: ${message}`);
  return 'failed';
}
