import { z } from 'zod';

import { db, desc, eq, slackInstallations, taskRuns } from '@roomote/db/server';
import { drainSlackMessagesToResumeJob } from '@roomote/slack';

import { authenticatedProcedure, jobScoped, router } from '../trpc';

export const slackInstallationsRouter = router({
  findFirst: authenticatedProcedure.query(() => {
    return db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      orderBy: [desc(slackInstallations.updatedAt)],
    });
  }),

  /**
   * Drain pending Slack messages after auto-snapshot.
   *
   * Called by the worker during shutdown when a snapshot was just created
   * for a Slack job. Checks for pending messages in Redis, and if any
   * exist, creates a SnapshotResume job so a new sandbox picks them up.
   */
  drainSlackMessages: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).mutation(async ({ input }) => {
    const cloudJob = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.cloudJobId),
      with: { task: true },
    });

    if (!cloudJob) {
      return { resumed: false, reason: 'job_not_found' } as const;
    }

    // The Slack thread binding lives on the run's task row.
    const slackThreadTs = cloudJob.task.slackThreadTs;

    if (!slackThreadTs) {
      return { resumed: false, reason: 'no_slack_thread' } as const;
    }

    const result = await drainSlackMessagesToResumeJob({
      id: cloudJob.id,
      slackThreadTs,
      snapshotId: cloudJob.snapshotId,
      payload: cloudJob.payload as Record<string, unknown>,
      port: cloudJob.port,
    });

    if (result.resumed) {
      console.log(
        `[drainSlackMessages] Created resume cloud job ${result.cloudJobId} for ${result.messageCount} pending message(s) from job ${cloudJob.id}`,
      );
    }

    return result;
  }),
});
