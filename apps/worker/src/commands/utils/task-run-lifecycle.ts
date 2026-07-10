import {
  RunStatus,
  CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY,
  type ConflictResolutionSummary,
} from '@roomote/types';
import { type TaskRun, sdk } from '@roomote/sdk/client';

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

function describeTaskRunFailure(error: unknown): string {
  if (error instanceof ExecutionError) {
    return formatExecutionErrorDetails(error);
  }

  return describeError(error);
}

function buildWorkerExceptionContext(params: {
  error: unknown;
  taskRun: TaskRun | undefined;
}): WorkerRuntimeContext {
  const { error, taskRun } = params;
  const context: WorkerRuntimeContext = {
    runId: taskRun?.id ?? null,
    stage: 'handleTaskRunError',
    ...(taskRun?.taskId ? { taskId: taskRun.taskId } : {}),
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
  taskRun,
  callbacks,
  context,
}: {
  result: {
    status: RunStatus;
    error?: string;
  };
  taskRun: TaskRun;
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
      taskRun.result &&
      typeof taskRun.result === 'object' &&
      !Array.isArray(taskRun.result)
        ? (taskRun.result as Record<string, unknown>)
        : {};

    const nextResult = {
      ...existingResult,
      [CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY]: conflictResolutionSummary,
    };

    try {
      await sdk.taskRuns.update({ id: taskRun.id, result: nextResult });
    } catch (error) {
      throw createLifecycleError(
        `taskRuns.update(result) failed during finalization for task run ${taskRun.id}`,
        error,
      );
    }
    taskRun.result = nextResult;
  }

  try {
    await sdk.taskRuns.done({
      id: taskRun.id,
      status: status as
        | RunStatus.Completed
        | RunStatus.Failed
        | RunStatus.Canceled
        | RunStatus.Idle,
      ...(error && { error }),
    });
  } catch (doneError) {
    throw createLifecycleError(
      `taskRuns.done(${status}) failed during finalization for task run ${taskRun.id}`,
      doneError,
    );
  }

  try {
    await callbacks.onExit?.(taskRun, status, context);
  } catch (exitError) {
    throw createLifecycleError(
      `callbacks.onExit failed during finalization for task run ${taskRun.id}`,
      exitError,
    );
  }

  if (status !== RunStatus.Completed) {
    console.error(`Job exited with status: ${status}`);
  }
}

export async function handleTaskRunError({
  error,
  taskRun,
  callbacks,
  context,
}: {
  error: unknown;
  taskRun: TaskRun | undefined;
  logger: HarnessLogger | undefined;
  callbacks: RunTaskCallbacks;
  context: RunTaskContext;
}): Promise<'failed'> {
  const message = describeTaskRunFailure(error);

  captureWorkerException(
    error,
    buildWorkerExceptionContext({ error, taskRun }),
  );

  if (taskRun) {
    await sdk.taskRuns.done({
      id: taskRun.id,
      status: RunStatus.Failed,
      error: message,
    });

    await callbacks.onExit?.(taskRun, RunStatus.Failed, context);
  }

  console.error(`❌ Job ${taskRun?.id ?? '<unknown>'} failed: ${message}`);
  return 'failed';
}
