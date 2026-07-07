import { NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';
import {
  createComputeProviderClient,
  getComputeProviderCapabilities,
} from '@roomote/compute-providers/factory';
import {
  isExitedCloudTaskStatus,
  resolveComputeProviderTarget,
} from '@roomote/types';

import { cloudJobs, db, eq } from '@roomote/db/server';

import { authorizeUserToken } from '@/lib/server';

export const runtime = 'nodejs';

const LOG_STREAM_READINESS_POLL_INTERVAL_MS = 2_000;
const LOG_STREAM_READINESS_MAX_WAIT_MS = 15 * 60_000;
const UNSUPPORTED_LOG_STREAMING_ERROR =
  'Live log streaming is unavailable for this compute provider.';

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
  const cloudJobId = z.coerce.number().parse(id);

  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
  });

  if (!cloudJob) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const provider = resolveComputeProviderTarget(cloudJob.vendor);
  const capabilities = getComputeProviderCapabilities(provider);

  if (!capabilities.supportsCommandOutputStreaming) {
    return createResponse(request, async (session) => {
      await pushSessionError(session, UNSUPPORTED_LOG_STREAMING_ERROR);
      await pushSessionDisconnect(session);
    });
  }

  return createResponse(request, async (session) => {
    const ac = new AbortController();
    let disconnected = false;
    let shouldReconnect = false;
    let machineId = cloudJob.machineId;
    let sandboxCmdId = cloudJob.sandboxCmdId;
    let status = cloudJob.status;
    const startedAt = Date.now();

    session.on('disconnected', () => {
      disconnected = true;
      ac.abort();
    });

    while (!disconnected && (!machineId || !sandboxCmdId)) {
      if (isExitedCloudTaskStatus(status)) {
        break;
      }

      if (Date.now() - startedAt >= LOG_STREAM_READINESS_MAX_WAIT_MS) {
        shouldReconnect = true;
        break;
      }

      await sleep(LOG_STREAM_READINESS_POLL_INTERVAL_MS);

      const latestCloudJob = await db.query.cloudJobs.findFirst({
        where: eq(cloudJobs.id, cloudJobId),
        columns: {
          machineId: true,
          sandboxCmdId: true,
          status: true,
        },
      });

      if (!latestCloudJob) {
        break;
      }

      machineId = latestCloudJob.machineId;
      sandboxCmdId = latestCloudJob.sandboxCmdId;
      status = latestCloudJob.status;
    }

    if (shouldReconnect || disconnected) {
      return;
    }

    if (!machineId || !sandboxCmdId) {
      await pushSessionDisconnect(session);
      return;
    }

    try {
      const client = createComputeProviderClient({ provider });

      if (!client.capabilities.supportsCommandOutputStreaming) {
        await pushSessionError(session, UNSUPPORTED_LOG_STREAMING_ERROR);
        await pushSessionDisconnect(session);
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
    }

    await pushSessionDisconnect(session);
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

async function pushSessionDisconnect(session: {
  isConnected: boolean;
  push: (data: unknown, event?: string) => unknown;
}): Promise<void> {
  if (!session.isConnected) {
    return;
  }

  try {
    await session.push(null, 'disconnect');
  } catch {
    // Client already disconnected, ignore.
  }
}
