import { NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';
import {
  createComputeProviderClient,
  getComputeProviderCapabilities,
} from '@roomote/compute-providers/factory';
import {
  buildTaskRunDisconnectEvent,
  formatOperationalEvent,
  isExitedRunStatus,
  resolveComputeProviderTarget,
  type TaskRunDisconnectEvent,
  type TaskRunDisconnectReasonCode,
} from '@roomote/types';

import {
  db,
  eq,
  resolveComputeProviderEnvValues,
  taskRuns,
} from '@roomote/db/server';

import { authorizeUserToken } from '@/lib/server';
import { canReadTask } from '@/lib/server/custom-automation-task-access';

export const runtime = 'nodejs';

const LOG_STREAM_READINESS_POLL_INTERVAL_MS = 2_000;
const LOG_STREAM_READINESS_MAX_WAIT_MS = 15 * 60_000;
const UNSUPPORTED_LOG_STREAMING_ERROR =
  'Live log streaming is unavailable for this sandbox provider.';

function logDisconnectEvent(event: TaskRunDisconnectEvent): void {
  if (event.disconnectReason.code === 'stream_completed') {
    return;
  }

  console.warn(
    formatOperationalEvent('task_runtime_log_stream_disconnect', {
      taskId: event.correlation.taskId,
      runId: event.correlation.runId,
      reason: event.disconnectReason.code,
      outcome: event.terminalReason ? 'terminal' : 'disconnected',
      status: event.terminalReason?.status,
    }),
  );
}

function createDisconnectEvent(
  taskRun: {
    taskId: string;
    status: Parameters<typeof buildTaskRunDisconnectEvent>[0]['status'];
    errorCode?: string | null;
    error?: string | null;
  },
  runId: number,
  reasonCode: TaskRunDisconnectReasonCode,
): TaskRunDisconnectEvent {
  return buildTaskRunDisconnectEvent({
    taskId: taskRun.taskId,
    runId,
    reasonCode,
    source: 'web',
    status: taskRun.status,
    errorCode: taskRun.errorCode,
    error: taskRun.error,
  });
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const authResult = await authorizeUserToken(request);

  if (!authResult.success) {
    return NextResponse.json(
      { error: 'Unauthorized request' },
      { status: 401 },
    );
  }

  const { id } = await props.params;
  const runId = z.coerce.number().parse(id);

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun || !(await canReadTask(authResult, taskRun.taskId))) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const provider = resolveComputeProviderTarget(taskRun.vendor);
  const capabilities = getComputeProviderCapabilities(provider);

  if (!capabilities.supportsCommandOutputStreaming) {
    return createResponse(request, async (session) => {
      await pushSessionError(session, UNSUPPORTED_LOG_STREAMING_ERROR);
      const disconnectEvent = createDisconnectEvent(
        taskRun,
        runId,
        'unsupported_provider',
      );
      logDisconnectEvent(disconnectEvent);
      await pushSessionDisconnect(session, disconnectEvent);
    });
  }

  return createResponse(request, async (session) => {
    const ac = new AbortController();
    let disconnected = false;
    let shouldReconnect = false;
    let machineId = taskRun.machineId;
    let sandboxCmdId = taskRun.sandboxCmdId;
    let status = taskRun.status;
    let errorCode = taskRun.errorCode;
    let error = taskRun.error;
    let runMissing = false;
    const startedAt = Date.now();

    session.on('disconnected', () => {
      disconnected = true;
      ac.abort();
    });

    while (!disconnected && (!machineId || !sandboxCmdId)) {
      if (isExitedRunStatus(status)) {
        break;
      }

      if (Date.now() - startedAt >= LOG_STREAM_READINESS_MAX_WAIT_MS) {
        shouldReconnect = true;
        console.warn(
          formatOperationalEvent('task_runtime_log_stream_disconnect', {
            taskId: taskRun.taskId,
            runId,
            reason: 'readiness_timeout',
            outcome: 'reconnecting',
            status,
          }),
        );
        break;
      }

      await sleep(LOG_STREAM_READINESS_POLL_INTERVAL_MS);

      const latestTaskRun = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, runId),
        columns: {
          machineId: true,
          sandboxCmdId: true,
          status: true,
          error: true,
          errorCode: true,
        },
      });

      if (!latestTaskRun) {
        runMissing = true;
        break;
      }

      machineId = latestTaskRun.machineId;
      sandboxCmdId = latestTaskRun.sandboxCmdId;
      status = latestTaskRun.status;
      errorCode = latestTaskRun.errorCode;
      error = latestTaskRun.error;
    }

    if (shouldReconnect || disconnected) {
      return;
    }

    if (!machineId || !sandboxCmdId) {
      const disconnectEvent = createDisconnectEvent(
        { ...taskRun, status, errorCode, error: error ?? null },
        runId,
        runMissing
          ? 'run_missing'
          : isExitedRunStatus(status)
            ? 'run_terminal'
            : 'sandbox_not_ready',
      );
      logDisconnectEvent(disconnectEvent);
      await pushSessionDisconnect(session, disconnectEvent);
      return;
    }

    let disconnectReason: TaskRunDisconnectReasonCode = 'stream_completed';

    try {
      const client = createComputeProviderClient({
        provider,
        envFallback: await resolveComputeProviderEnvValues(provider),
      });

      if (!client.capabilities.supportsCommandOutputStreaming) {
        await pushSessionError(session, UNSUPPORTED_LOG_STREAMING_ERROR);
        const disconnectEvent = createDisconnectEvent(
          { ...taskRun, status, errorCode, error: error ?? null },
          runId,
          'unsupported_provider',
        );
        logDisconnectEvent(disconnectEvent);
        await pushSessionDisconnect(session, disconnectEvent);
        return;
      }

      for await (const entry of client.streamCommandOutput({
        instanceId: machineId,
        commandId: sandboxCmdId,
        signal: ac.signal,
      })) {
        if (!session.isConnected) {
          break;
        }

        try {
          await session.push({ stream: entry.stream, data: entry.data }, 'log');
        } catch {
          break;
        }
      }
    } catch (error) {
      if (ac.signal.aborted) {
        return;
      }

      await pushSessionError(
        session,
        error instanceof Error ? error.message : 'Failed to stream logs',
      );
      disconnectReason = 'provider_stream_error';
    }

    const latestTaskRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
      columns: {
        status: true,
        error: true,
        errorCode: true,
      },
    });
    const disconnectEvent = latestTaskRun
      ? createDisconnectEvent(
          {
            ...taskRun,
            status: latestTaskRun.status,
            errorCode: latestTaskRun.errorCode,
            error: latestTaskRun.error,
          },
          runId,
          disconnectReason,
        )
      : createDisconnectEvent(
          { ...taskRun, status, errorCode, error: error ?? null },
          runId,
          'run_missing',
        );
    logDisconnectEvent(disconnectEvent);
    await pushSessionDisconnect(session, disconnectEvent);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pushSessionError(
  session: {
    isConnected: boolean;
    push: (data: unknown, event?: string) => unknown;
  },
  error: string,
): Promise<void> {
  if (!session.isConnected) {
    return;
  }

  try {
    await session.push({ error }, 'error');
  } catch {
    // Client already disconnected, ignore.
  }
}

async function pushSessionDisconnect(
  session: {
    isConnected: boolean;
    push: (data: unknown, event?: string) => unknown;
  },
  data?: TaskRunDisconnectEvent,
): Promise<void> {
  if (!session.isConnected) {
    return;
  }

  try {
    await session.push(data ?? null, 'disconnect');
  } catch {
    // Client already disconnected, ignore.
  }
}
