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
  isExitedCloudTaskStatus,
  resolveComputeProviderTarget,
} from '@roomote/types';

import type { Variables } from '../../types';

const LOG_STREAM_READINESS_POLL_INTERVAL_MS = 2_000;

const LOG_STREAM_READINESS_MAX_WAIT_MS = 15 * 60_000;

const UNSUPPORTED_LOG_STREAMING_ERROR =
  'Live log streaming is unavailable for this sandbox provider.';

export async function getCloudJobLogs(c: Context<{ Variables: Variables }>) {
  const authContext = c.get('authContext');

  if (!authContext) {
    return c.json({ error: 'Unauthorized request' }, 401);
  }

  const cloudJobId = Number(c.req.param('id'));

  const scopedCloudJobId =
    'cloudJobId' in authContext ? authContext.cloudJobId : undefined;

  return streamCloudJobLogs({
    c,
    cloudJobId,
    scopedCloudJobId,
  });
}

async function streamCloudJobLogs({
  c,
  cloudJobId,
  scopedCloudJobId,
}: {
  c: Context<{ Variables: Variables }>;
  cloudJobId: number;
  scopedCloudJobId?: number;
}): Promise<Response> {
  if (!Number.isInteger(cloudJobId) || cloudJobId <= 0) {
    return c.json({ error: 'Invalid cloud job id' }, 400);
  }

  if (scopedCloudJobId && scopedCloudJobId !== cloudJobId) {
    return c.json(
      { error: 'Cloud job token does not match requested cloud job' },
      403,
    );
  }

  const cloudJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, cloudJobId),
  });

  if (!cloudJob) {
    return c.json({ error: 'Not Found' }, 404);
  }

  const provider = resolveComputeProviderTarget(cloudJob.vendor);
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
    let machineId = cloudJob.machineId;
    let sandboxCmdId = cloudJob.sandboxCmdId;
    let status = cloudJob.status;
    const startedAt = Date.now();

    while (!signal.aborted && (!machineId || !sandboxCmdId)) {
      if (isExitedCloudTaskStatus(status)) {
        break;
      }

      if (Date.now() - startedAt >= LOG_STREAM_READINESS_MAX_WAIT_MS) {
        await writeSSE(stream, 'disconnect', null);
        return;
      }

      await sleep(LOG_STREAM_READINESS_POLL_INTERVAL_MS);

      const latestCloudJob = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, cloudJobId),
        columns: { machineId: true, sandboxCmdId: true, status: true },
      });

      if (!latestCloudJob) {
        await writeSSE(stream, 'disconnect', null);
        return;
      }

      machineId = latestCloudJob.machineId;
      sandboxCmdId = latestCloudJob.sandboxCmdId;
      status = latestCloudJob.status;
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
