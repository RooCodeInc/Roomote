import { z } from 'zod';

import {
  cloudJobs,
  db,
  desc,
  eq,
  slackInstallations,
} from '@roomote/db/server';
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
    const cloudJob = await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, input.cloudJobId),
    });

    if (!cloudJob) {
      return { resumed: false, reason: 'job_not_found' } as const;
    }

    if (!cloudJob.slackThreadTs) {
      return { resumed: false, reason: 'no_slack_thread' } as const;
    }

    const result = await drainSlackMessagesToResumeJob(
      cloudJob as Parameters<typeof drainSlackMessagesToResumeJob>[0],
    );

    if (result.resumed) {
      console.log(
        `[drainSlackMessages] Created resume cloud job ${result.cloudJobId} for ${result.messageCount} pending message(s) from job ${cloudJob.id}`,
      );
    }

    return result;
  }),
});
