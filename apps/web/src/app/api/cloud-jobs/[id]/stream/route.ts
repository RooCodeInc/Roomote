import { NextRequest, NextResponse } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';

import { CloudTaskStatus, isExitedCloudTaskStatus } from '@roomote/types';
import { cloudJobs, db, eq } from '@roomote/db/server';

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
  const cloudJobId = z.coerce.number().parse(id);

  const findCloudJob = () =>
    db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, cloudJobId),
    });

  const cloudJob = await findCloudJob();

  if (!cloudJob) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  return createResponse(request, async (session) => {
    const startTime = Date.now();

    while (startTime + 60 * 60 * 1_000 > Date.now()) {
      if (!session.isConnected) {
        break;
      }

      const cloudJob = await findCloudJob();

      if (!cloudJob) {
        break;
      }

      try {
        await session.push(cloudJob, 'message');
      } catch {
        break;
      }

      if (isExitedCloudTaskStatus(cloudJob.status)) {
        break;
      }

      const timeout =
        cloudJob.status === CloudTaskStatus.Running ? 10_000 : 1_000;

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
