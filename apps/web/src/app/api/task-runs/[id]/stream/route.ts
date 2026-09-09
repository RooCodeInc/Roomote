import { NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';

import { RunStatus, isExitedRunStatus } from '@roomote/types';
import { db, eq, taskRuns } from '@roomote/db/server';

import { authorizeUserToken } from '@/lib/server';
import { canReadTask } from '@/lib/server/custom-automation-task-access';
import { getTaskRunError } from '@/lib/task-run-errors';
import type { TaskRunProgress } from '@/types';

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

  const findTaskRun = async (): Promise<TaskRunProgress | undefined> => {
    const run = await db.query.taskRuns.findFirst({
      columns: {
        id: true,
        taskId: true,
        status: true,
        vendor: true,
        error: true,
        errorCode: true,
        result: true,
      },
      where: eq(taskRuns.id, runId),
    });
    if (!run || !(await canReadTask(authResult, run.taskId))) return undefined;
    // Preserve the legacy result.error fallback without streaming arbitrary JSON.
    return {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      vendor: run.vendor,
      error: getTaskRunError(run) ?? null,
      errorCode: run.errorCode,
    };
  };

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
