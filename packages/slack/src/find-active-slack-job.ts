import {
  db,
  cloudJobs,
  eq,
  and,
  inArray,
  isNull,
  desc,
} from '@roomote/db/server';
import { activeCloudTaskStatuses } from '@roomote/types';

import { slackDebug } from './logging';

/**
 * Find an active cloud job for a given Slack thread.
 * Returns the most recent non-terminal job for the thread.
 *
 * Slack follow-up delivery is keyed by cloud job ID, so the webhook can queue
 * messages as soon as the job exists instead of waiting for the worker machine
 * to finish booting.
 */
export async function findActiveSlackJob(slackThreadTs: string) {
  slackDebug(
    `[findActiveSlackJob] Searching for active job in thread ${slackThreadTs}`,
  );

  const activeJob = await db.query.cloudJobs.findFirst({
    where: and(
      eq(cloudJobs.slackThreadTs, slackThreadTs),
      inArray(cloudJobs.status, [...activeCloudTaskStatuses]),
      isNull(cloudJobs.canceledAt),
    ),
    orderBy: desc(cloudJobs.createdAt),
  });

  if (activeJob) {
    slackDebug(
      `[findActiveSlackJob] Found active job ${activeJob.id} (status: ${activeJob.status}, machine: ${activeJob.machineId}, task: ${activeJob.taskId})`,
    );
  } else {
    slackDebug(
      `[findActiveSlackJob] No active job found for thread ${slackThreadTs}`,
    );

    // Diagnostic: query the latest job in this thread regardless of status
    // so we can tell if the job exists but moved to a terminal state.
    const latestJob = await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.slackThreadTs, slackThreadTs),
      orderBy: desc(cloudJobs.createdAt),
    });

    if (latestJob) {
      slackDebug(
        `[findActiveSlackJob] Latest job in thread ${slackThreadTs}: id=${latestJob.id} status=${latestJob.status} machineId=${latestJob.machineId ?? 'null'} taskId=${latestJob.taskId ?? 'null'} createdAt=${latestJob.createdAt}`,
      );
    } else {
      slackDebug(
        `[findActiveSlackJob] No jobs at all found for thread ${slackThreadTs}`,
      );
    }
  }

  return activeJob;
}
