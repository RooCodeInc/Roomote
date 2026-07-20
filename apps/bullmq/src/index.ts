import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { showRoutes } from 'hono/dev';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';

import {
  bootstrapGeneratedAuthKeypairs,
  ensureAutomationRows,
} from '@roomote/db/server';
import {
  DISCORD_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  SLACK_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  TEAMS_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  TELEGRAM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
} from '@roomote/sdk/server';
import {
  assertSecureBootBinding,
  Env,
  resolveDashboardPassword,
} from '@roomote/env';
import {
  buildRoomoteDeployMarker,
  formatRoomoteDeployMarker,
} from '@roomote/types';
import { startDiscordGatewaySupervisor } from '@roomote/discord-gateway';

import {
  createAdminDashboardMiddleware,
  resolveAdminDashboardAuth,
} from './admin-auth';
import { captureBullMqMessage, initBullMqSentry } from './monitoring/sentry';
import { getRedis, closeRedis } from './redis';
import { startScheduler } from './scheduler';
import { startSandboxOidcRefreshQueue } from './sandbox-oidc-refresh-queue';
import { startSlackAccountLinkEducationQueue } from './slack-account-link-education-queue';
import { startSuggestedTasksOnboardingFollowupQueue } from './suggested-tasks-onboarding-followup-queue';
import { discordSuggestedTasksOnboardingFollowupJob } from './jobs/discord-suggested-tasks-onboarding-followup';
import { slackSuggestedTasksOnboardingFollowupJob } from './jobs/slack-suggested-tasks-onboarding-followup';
import { telegramSuggestedTasksOnboardingFollowupJob } from './jobs/telegram-suggested-tasks-onboarding-followup';
import { teamsSuggestedTasksOnboardingFollowupJob } from './jobs/teams-suggested-tasks-onboarding-followup';
import { startSnapshotQueue } from './snapshot-queue';
import { startDockerValidationQueue } from './docker-validation-queue';
import { startSlackPrInactivityQueue } from './slack-pr-inactivity-queue';
import { startPrReviewNotificationQueue } from './pr-review-notification-queue';
import { startTaskSleepQueue } from './task-sleep-queue';

// Resolve auto-generated auth keypairs before any queue worker starts so
// scheduled jobs that sign tokens observe the resolved keys.
try {
  await bootstrapGeneratedAuthKeypairs();
  assertSecureBootBinding();
} catch (error) {
  console.error('Failed to bootstrap generated auth keypairs', error);
  process.exit(1);
}

// Seed one automations row per known key so due-gating reads and the
// tasks.initiator_automation FK always have rows to reference.
try {
  await ensureAutomationRows();
} catch (error) {
  console.error('Failed to seed automations rows', error);
  process.exit(1);
}

const redis = getRedis();

initBullMqSentry();

const discordGatewaySupervisor = startDiscordGatewaySupervisor(
  redis,
  {
    ...process.env,
    ENCRYPTION_KEY: Env.ENCRYPTION_KEY,
    R_DISCORD_GATEWAY_SECRET: Env.R_DISCORD_GATEWAY_SECRET,
    TRPC_URL: Env.TRPC_URL,
  },
  {
    // A dead supervisor silently stops Discord ingestion while this process
    // stays green; make sure it pages instead of only logging.
    onFatal: (error) =>
      captureBullMqMessage(
        `Discord gateway supervisor stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { component: 'discord-gateway', signal: 'discord-gateway-fatal' },
      ),
  },
);

const { schedulerQueue, schedulerWorker, schedulerQueueEvents } =
  startScheduler();
const {
  sandboxOidcRefreshQueue,
  sandboxOidcRefreshWorker,
  sandboxOidcRefreshQueueEvents,
} = startSandboxOidcRefreshQueue();

const { snapshotQueue, snapshotWorker, snapshotQueueEvents } =
  startSnapshotQueue();
const {
  dockerValidationQueue,
  dockerValidationWorker,
  dockerValidationQueueEvents,
} = startDockerValidationQueue();
const {
  queue: taskSleepQueue,
  worker: taskSleepWorker,
  queueEvents: taskSleepQueueEvents,
} = startTaskSleepQueue();
const {
  slackAccountLinkEducationQueue,
  slackAccountLinkEducationWorker,
  slackAccountLinkEducationQueueEvents,
} = startSlackAccountLinkEducationQueue();
const {
  queue: discordSuggestedTasksOnboardingFollowupQueue,
  worker: discordSuggestedTasksOnboardingFollowupWorker,
} = startSuggestedTasksOnboardingFollowupQueue({
  queueName: DISCORD_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  label: 'DiscordSuggestedTasksOnboardingFollowupQueue',
  jobHandler: discordSuggestedTasksOnboardingFollowupJob,
});
const {
  queue: slackSuggestedTasksOnboardingFollowupQueue,
  worker: slackSuggestedTasksOnboardingFollowupWorker,
  queueEvents: slackSuggestedTasksOnboardingFollowupQueueEvents,
} = startSuggestedTasksOnboardingFollowupQueue({
  queueName: SLACK_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  label: 'SlackSuggestedTasksOnboardingFollowupQueue',
  jobHandler: slackSuggestedTasksOnboardingFollowupJob,
  withQueueEvents: true,
});
const {
  queue: telegramSuggestedTasksOnboardingFollowupQueue,
  worker: telegramSuggestedTasksOnboardingFollowupWorker,
} = startSuggestedTasksOnboardingFollowupQueue({
  queueName: TELEGRAM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  label: 'TelegramSuggestedTasksOnboardingFollowupQueue',
  jobHandler: telegramSuggestedTasksOnboardingFollowupJob,
});
const {
  queue: teamsSuggestedTasksOnboardingFollowupQueue,
  worker: teamsSuggestedTasksOnboardingFollowupWorker,
} = startSuggestedTasksOnboardingFollowupQueue({
  queueName: TEAMS_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  label: 'TeamsSuggestedTasksOnboardingFollowupQueue',
  jobHandler: teamsSuggestedTasksOnboardingFollowupJob,
});
const {
  slackPrInactivityQueue,
  slackPrInactivityWorker,
  slackPrInactivityQueueEvents,
} = startSlackPrInactivityQueue();
const {
  prReviewNotificationQueue,
  prReviewNotificationWorker,
  prReviewNotificationQueueEvents,
} = startPrReviewNotificationQueue();

const serverAdapter = new HonoAdapter(serveStatic);

createBullBoard({
  queues: [
    new BullMQAdapter(schedulerQueue, { readOnlyMode: false }),
    new BullMQAdapter(sandboxOidcRefreshQueue, { readOnlyMode: false }),
    new BullMQAdapter(snapshotQueue, { readOnlyMode: false }),
    new BullMQAdapter(dockerValidationQueue, { readOnlyMode: false }),
    new BullMQAdapter(taskSleepQueue, { readOnlyMode: false }),
    new BullMQAdapter(slackAccountLinkEducationQueue, { readOnlyMode: false }),
    new BullMQAdapter(discordSuggestedTasksOnboardingFollowupQueue, {
      readOnlyMode: false,
    }),
    new BullMQAdapter(slackSuggestedTasksOnboardingFollowupQueue, {
      readOnlyMode: false,
    }),
    new BullMQAdapter(telegramSuggestedTasksOnboardingFollowupQueue, {
      readOnlyMode: false,
    }),
    new BullMQAdapter(teamsSuggestedTasksOnboardingFollowupQueue, {
      readOnlyMode: false,
    }),
    new BullMQAdapter(slackPrInactivityQueue, { readOnlyMode: false }),
    new BullMQAdapter(prReviewNotificationQueue, { readOnlyMode: false }),
  ],
  serverAdapter,
});

serverAdapter.setBasePath('/admin/queues');

const app = new Hono();

// app.use(logger());

// Gate the queue dashboard on a configured password, never on NODE_ENV: the
// self-host stack runs this service as `NODE_ENV=development`, so a NODE_ENV
// skip would serve Bull Board (write access to every queue) unauthenticated.
// The operational `/admin/health` endpoint is exempted inside the middleware so
// the `pnpm dev` doctor health probe (apps/dev/src/doctor.ts) and external
// monitoring keep working without dashboard credentials.
const adminDashboardAuth = resolveAdminDashboardAuth(
  resolveDashboardPassword(),
);

if (adminDashboardAuth.mode !== 'basic-auth') {
  // Fail closed: refuse to expose the dashboard without a password. Queue
  // workers keep running; only the /admin surface is disabled.
  console.warn(
    '⚠️ DASHBOARD_PASSWORD is not configured; the /admin queue dashboard is disabled.',
  );
}

app.use('/admin/*', createAdminDashboardMiddleware(adminDashboardAuth));

app.get('/admin/health', async (c) => {
  try {
    const jobCounts = await schedulerQueue.getJobCounts();
    const sandboxOidcRefreshJobCounts =
      await sandboxOidcRefreshQueue.getJobCounts();

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        redis: redis?.status ?? 'unhealthy',
        queues: {
          scheduler: {
            waiting: jobCounts.waiting,
            active: jobCounts.active,
            completed: jobCounts.completed,
            failed: jobCounts.failed,
            delayed: jobCounts.delayed,
            repeat: jobCounts.repeat,
          },
          sandboxOidcRefresh: {
            waiting: sandboxOidcRefreshJobCounts.waiting,
            active: sandboxOidcRefreshJobCounts.active,
            completed: sandboxOidcRefreshJobCounts.completed,
            failed: sandboxOidcRefreshJobCounts.failed,
            delayed: sandboxOidcRefreshJobCounts.delayed,
            repeat: sandboxOidcRefreshJobCounts.repeat,
          },
        },
      },
    });
  } catch (error) {
    return c.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      503,
    );
  }
});

app.get('/admin/stats', async (c) => {
  try {
    const jobCounts = await schedulerQueue.getJobCounts();
    const jobSchedulers = await schedulerQueue.getJobSchedulers();
    const sandboxOidcRefreshJobCounts =
      await sandboxOidcRefreshQueue.getJobCounts();
    const sandboxOidcRefreshJobSchedulers =
      await sandboxOidcRefreshQueue.getJobSchedulers();

    return c.json({
      timestamp: new Date().toISOString(),
      queues: {
        scheduler: {
          ...jobCounts,
          repeatableJobs: jobSchedulers.map((job) => ({
            key: job.key,
            pattern: job.pattern,
            next: job.next ? new Date(job.next).toISOString() : null,
          })),
        },
        sandboxOidcRefresh: {
          ...sandboxOidcRefreshJobCounts,
          repeatableJobs: sandboxOidcRefreshJobSchedulers.map((job) => ({
            key: job.key,
            pattern: job.pattern,
            next: job.next ? new Date(job.next).toISOString() : null,
          })),
        },
      },
    });
  } catch (error) {
    return c.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      503,
    );
  }
});

app.route('/admin/queues', serverAdapter.registerPlugin());

app.get('/', (c) => c.redirect('/admin/queues'));

async function gracefulShutdown() {
  console.log('[Shutdown] Starting graceful shutdown...');

  try {
    await schedulerWorker.close();
    await schedulerQueueEvents.close();
    await schedulerQueue.close();
    await sandboxOidcRefreshWorker.close();
    await sandboxOidcRefreshQueueEvents.close();
    await sandboxOidcRefreshQueue.close();
    await snapshotWorker.close();
    await snapshotQueueEvents.close();
    await snapshotQueue.close();
    await dockerValidationWorker.close();
    await dockerValidationQueueEvents.close();
    await dockerValidationQueue.close();
    await taskSleepWorker.close();
    await taskSleepQueueEvents.close();
    await taskSleepQueue.close();
    await slackAccountLinkEducationWorker.close();
    await slackAccountLinkEducationQueueEvents.close();
    await slackAccountLinkEducationQueue.close();
    await discordSuggestedTasksOnboardingFollowupWorker.close();
    await discordSuggestedTasksOnboardingFollowupQueue.close();
    await slackSuggestedTasksOnboardingFollowupWorker.close();
    await slackSuggestedTasksOnboardingFollowupQueueEvents?.close();
    await slackSuggestedTasksOnboardingFollowupQueue.close();
    await telegramSuggestedTasksOnboardingFollowupWorker.close();
    await teamsSuggestedTasksOnboardingFollowupWorker.close();
    await telegramSuggestedTasksOnboardingFollowupQueue.close();
    await teamsSuggestedTasksOnboardingFollowupQueue.close();
    await slackPrInactivityWorker.close();
    await slackPrInactivityQueueEvents.close();
    await slackPrInactivityQueue.close();
    await prReviewNotificationWorker.close();
    await prReviewNotificationQueueEvents.close();
    await prReviewNotificationQueue.close();
    await discordGatewaySupervisor.stop();
    await closeRedis();
  } catch (error) {
    console.error('[Shutdown] Error during shutdown:', error);
  }

  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

const port = Number(process.env.PORT || 13002);

serve({ fetch: app.fetch, port }, ({ port }) => {
  if (Env.NODE_ENV === 'development') {
    showRoutes(app);
  }

  console.info(
    formatRoomoteDeployMarker(buildRoomoteDeployMarker({ service: 'bullmq' })),
  );
  console.log(`
╔══════════════════════════════════════════════════╗
║ BullMQ Dashboard Server                          ║
╠══════════════════════════════════════════════════╣
║ Environment: ${Env.NODE_ENV}                     ║
║ Dashboard: http://localhost:${port}/admin/queues ║
║ Health: http://localhost:${port}/health          ║
╚══════════════════════════════════════════════════╝
    `);
});
