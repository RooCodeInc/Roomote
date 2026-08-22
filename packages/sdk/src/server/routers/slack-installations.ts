import { z } from 'zod';

import { db, desc, eq, slackInstallations, taskRuns } from '@roomote/db/server';
import { drainSlackMessagesToResumeRun } from '@roomote/slack';

import { authenticatedProcedure, runScoped, router } from '../trpc';

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
   * exist, creates a SnapshotResume run so a new sandbox picks them up.
   */
  drainSlackMessages: runScoped(
    z.object({ runId: z.number() }),
    'runId',
  ).mutation(async ({ input }) => {
    const taskRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.runId),
      with: { task: true },
    });

    if (!taskRun) {
      return { resumed: false, reason: 'job_not_found' } as const;
    }

    // The Slack thread binding lives on the run's task row.
    const slackThreadTs = taskRun.task.slackThreadTs;

    if (!slackThreadTs) {
      return { resumed: false, reason: 'no_slack_thread' } as const;
    }

    const result = await drainSlackMessagesToResumeRun({
      id: taskRun.id,
      taskId: taskRun.taskId,
      slackThreadTs,
      snapshotId: taskRun.snapshotId,
      payload: taskRun.payload as Record<string, unknown>,
      port: taskRun.port,
    });

    if (result.resumed) {
      console.log(
        `[drainSlackMessages] Created resume task run ${result.runId} for ${result.messageCount} pending message(s) from job ${taskRun.id}`,
      );
    }

    return result;
  }),
});
