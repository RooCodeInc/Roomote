import { NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';

import { RunStatus, isExitedRunStatus } from '@roomote/types';
import { db, eq, taskRuns } from '@roomote/db/server';

import { authorizeUserToken } from '@/lib/server';

export const runtime = 'nodejs';

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

  const findTaskRun = () =>
    db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
    });

  const taskRun = await findTaskRun();

  if (!taskRun) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  return createResponse(request, async (session) => {
    const startTime = Date.now();

    while (startTime + 60 * 60 * 1_000 > Date.now()) {
      if (!session.isConnected) {
        break;
      }

      const taskRun = await findTaskRun();

      if (!taskRun) {
        break;
      }

      try {
        await session.push(taskRun, 'message');
      } catch {
        break;
      }

      if (isExitedRunStatus(taskRun.status)) {
        break;
      }

      const timeout = taskRun.status === RunStatus.Running ? 10_000 : 1_000;

      await new Promise((resolve) => setTimeout(resolve, timeout));
    }

    if (session.isConnected) {
      try {
        await session.push(null, 'disconnect');
      } catch {
        // Client already disconnected, ignore.
      }
    }
  });
}
