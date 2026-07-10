import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

import { createComputeProviderClient } from '@roomote/compute-providers';
import {
  db,
  eq,
  resolveComputeProviderEnvValues,
  taskRuns,
} from '@roomote/db/server';
import {
  isExitedRunStatus,
  resolveComputeProviderTarget,
} from '@roomote/types';

import type { Variables } from '../../types';

const LOG_STREAM_READINESS_POLL_INTERVAL_MS = 2_000;

const LOG_STREAM_READINESS_MAX_WAIT_MS = 15 * 60_000;

const UNSUPPORTED_LOG_STREAMING_ERROR =
  'Live log streaming is unavailable for this sandbox provider.';

export async function getTaskRunLogs(c: Context<{ Variables: Variables }>) {
  const authContext = c.get('authContext');

  if (!authContext) {
    return c.json({ error: 'Unauthorized request' }, 401);
  }

  const runId = Number(c.req.param('id'));

  const scopedRunId = 'runId' in authContext ? authContext.runId : undefined;

  return streamTaskRunLogs({
    c,
    runId,
    scopedRunId,
  });
}

async function streamTaskRunLogs({
  c,
  runId,
  scopedRunId,
}: {
  c: Context<{ Variables: Variables }>;
  runId: number;
  scopedRunId?: number;
}): Promise<Response> {
  if (!Number.isInteger(runId) || runId <= 0) {
    return c.json({ error: 'Invalid task run id' }, 400);
  }

  if (scopedRunId && scopedRunId !== runId) {
    return c.json(
      { error: 'Task run token does not match requested task run' },
      403,
    );
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun) {
    return c.json({ error: 'Not Found' }, 404);
  }

  const provider = resolveComputeProviderTarget(taskRun.vendor);
  const client = createComputeProviderClient({
    provider,
    envFallback: await resolveComputeProviderEnvValues(provider),
  });

  if (!client.capabilities.supportsCommandOutputStreaming) {
    return streamStartupLogs(c, async (stream) => {
      await writeSSE(stream, 'error', {
        error: UNSUPPORTED_LOG_STREAMING_ERROR,
      });
      await writeSSE(stream, 'disconnect', null);
    });
  }

  const signal = c.req.raw.signal;

  return streamStartupLogs(c, async (stream) => {
    let machineId = taskRun.machineId;
    let sandboxCmdId = taskRun.sandboxCmdId;
    let status = taskRun.status;
    const startedAt = Date.now();

    while (!signal.aborted && (!machineId || !sandboxCmdId)) {
      if (isExitedRunStatus(status)) {
        break;
      }

      if (Date.now() - startedAt >= LOG_STREAM_READINESS_MAX_WAIT_MS) {
        await writeSSE(stream, 'disconnect', null);
        return;
      }

      await sleep(LOG_STREAM_READINESS_POLL_INTERVAL_MS);

      const latestTaskRun = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, runId),
        columns: { machineId: true, sandboxCmdId: true, status: true },
      });

      if (!latestTaskRun) {
        await writeSSE(stream, 'disconnect', null);
        return;
      }

      machineId = latestTaskRun.machineId;
      sandboxCmdId = latestTaskRun.sandboxCmdId;
      status = latestTaskRun.status;
    }

    if (signal.aborted || stream.aborted) {
      return;
    }

    if (!machineId || !sandboxCmdId) {
      await writeSSE(stream, 'disconnect', null);
      return;
    }

    try {
      for await (const entry of client.streamCommandOutput({
        instanceId: machineId,
        commandId: sandboxCmdId,
        signal,
      })) {
        if (signal.aborted || stream.aborted) {
          return;
        }

        await writeSSE(stream, 'log', {
          stream: entry.stream,
          data: entry.data,
        });
      }
    } catch (error) {
      if (signal.aborted || stream.aborted) {
        return;
      }

      await writeSSE(stream, 'error', {
        error: error instanceof Error ? error.message : 'Failed to stream logs',
      });
    }

    await writeSSE(stream, 'disconnect', null);
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamStartupLogs(
  c: Context<{ Variables: Variables }>,
  producer: (stream: SSEStreamingApi) => Promise<void>,
): Response {
  const signal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    try {
      await producer(stream);
    } catch (error) {
      if (signal.aborted || stream.aborted) {
        return;
      }

      await writeSSE(stream, 'error', {
        error: error instanceof Error ? error.message : 'Failed to stream logs',
      });
      await writeSSE(stream, 'disconnect', null);
    }
  });
}

function writeSSE(
  stream: SSEStreamingApi,
  event: string,
  data: unknown,
): Promise<void> {
  return stream.writeSSE({
    event,
    data: data === null ? 'null' : JSON.stringify(data),
  });
}
