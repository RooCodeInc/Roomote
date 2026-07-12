import { Queue, QueueEvents, Worker, Job } from 'bullmq';

import {
  announcerJob,
  codeQualityAuditorJob,
  conflictScanJob,
  dependabotTriageJob,
  managerStatsJob,
  securityAuditorJob,
  sentryTriageJob,
  suggesterJob,
  type AutomationJobResult,
  type AutomationRunOpts,
} from '@roomote/sdk/server';

import { getRedis } from './redis';
import {
  ScheduledJobName,
  type ScheduledAutomationJobName,
  type SchedulerJobName,
} from './types';
import {
  heartbeatJob,
  sleepCheckJob,
  refreshSnapshotsJob,
  pullRequestAnalyticsSyncJob,
  instancePingJob,
  webhookCleanupJob,
  standbyRetentionJob,
} from './scheduled-jobs';

const QUEUE_NAME = 'scheduled-jobs';

// Scheduler names retired by the Stage 3 automations consolidation: legacy
// CamelCase automation jobs (now named by automation key), the deleted Coach
// automation, and pre-rename infra aliases. Removed once at startup.
const RETIRED_JOB_SCHEDULER_NAMES = [
  'SnapshotCheck',
  'QueueConsumer',
  'Coach',
  'ConflictScan',
  'Announcer',
  'Suggester',
  'ManagerStats',
  'SentryTriage',
  'DependabotTriage',
  'SecurityAuditor',
  'CodeQualityAuditor',
  'CiFailureTriage',
] as const;

type ScheduledJob = Job<unknown, void, string>;

const AUTOMATION_JOBS: Record<
  ScheduledAutomationJobName,
  (opts?: AutomationRunOpts) => Promise<AutomationJobResult>
> = {
  conflict_resolver: conflictScanJob,
  suggester: suggesterJob,
  announcer: announcerJob,
  manager_stats: managerStatsJob,
  sentry_triage: sentryTriageJob,
  dependabot_triage: dependabotTriageJob,
  security_auditor: securityAuditorJob,
  code_quality_auditor: codeQualityAuditorJob,
};

function isAutomationJobName(name: string): name is ScheduledAutomationJobName {
  return name in AUTOMATION_JOBS;
}

async function createJobs(queue: Queue): Promise<void> {
  for (const retiredName of RETIRED_JOB_SCHEDULER_NAMES) {
    await queue.removeJobScheduler(retiredName);
  }

  await queue.upsertJobScheduler(
    ScheduledJobName.Heartbeat,
    { every: 1 * 60 * 60 * 1000 }, // Every hour.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.SleepCheck,
    { every: 60 * 1000 }, // Every 60 seconds.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.StandbyRetention,
    { every: 5 * 60 * 1000 }, // Every 5 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.RefreshSnapshots,
    { every: 24 * 60 * 60 * 1000 }, // Every 24 hours.
  );

  // Automation jobs tick hourly (manager_stats hourly on its posting days)
  // and due-gate themselves against automations.enabled/schedule/lastRunAt.
  await queue.upsertJobScheduler(
    'conflict_resolver' satisfies ScheduledAutomationJobName,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    'announcer' satisfies ScheduledAutomationJobName,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    'suggester' satisfies ScheduledAutomationJobName,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    'manager_stats' satisfies ScheduledAutomationJobName,
    { pattern: '0 * * * 5,6' }, // Hourly on UTC Friday/Saturday.
  );

  await queue.upsertJobScheduler(
    'sentry_triage' satisfies ScheduledAutomationJobName,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    'dependabot_triage' satisfies ScheduledAutomationJobName,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    'security_auditor' satisfies ScheduledAutomationJobName,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    'code_quality_auditor' satisfies ScheduledAutomationJobName,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.PullRequestAnalyticsSync,
    { every: 15 * 60 * 1000 }, // Every 15 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.InstancePing,
    { every: 24 * 60 * 60 * 1000 }, // Every 24 hours.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.WebhookCleanup,
    { every: 24 * 60 * 60 * 1000 }, // Every 24 hours.
  );

  const schedulers = await queue.getJobSchedulers();
  console.log('[createJobs] getJobSchedulers ->', schedulers);
}

const runJobs = async (job: ScheduledJob): Promise<void> => {
  console.log(`[runJobs] processing job ${job.id} of type ${job.name}`);

  if (isAutomationJobName(job.name)) {
    await AUTOMATION_JOBS[job.name]();
    return;
  }

  switch (job.name) {
    case ScheduledJobName.Heartbeat:
      return heartbeatJob();
    case ScheduledJobName.SleepCheck:
      return sleepCheckJob();
    case ScheduledJobName.RefreshSnapshots:
      return refreshSnapshotsJob();
    case ScheduledJobName.PullRequestAnalyticsSync:
      return pullRequestAnalyticsSyncJob(job.data ?? {});
    case ScheduledJobName.InstancePing:
      return instancePingJob();
    case ScheduledJobName.WebhookCleanup:
      return webhookCleanupJob();
    case ScheduledJobName.StandbyRetention:
      return standbyRetentionJob();
    default:
      throw new Error(`Unknown job type: ${job.name}`);
  }
};

export function startScheduler() {
  const connection = getRedis();

  const queue = new Queue<unknown, void, SchedulerJobName>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      // Keep completed jobs for 1 hour.
      // Keep max 100 completed jobs.
      removeOnComplete: { age: 3600, count: 100 },
      // Keep failed jobs for 24 hours.
      removeOnFail: { age: 24 * 3600 },
    },
  });

  const worker = new Worker<unknown, void, string>(QUEUE_NAME, runJobs, {
    connection,
    concurrency: 5,
    autorun: true,
  });

  worker.on('completed', (job) =>
    console.log(`[Worker#on(completed)] job ${job.id} completed successfully`),
  );

  worker.on('failed', (job, err) =>
    console.error(`[Worker#on(failed)] job ${job?.id} failed:`, err),
  );

  worker.on('error', (err) =>
    console.error('[Worker#on(error)] error ->', err),
  );

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

  queueEvents.on('completed', ({ jobId }) =>
    console.log(`[QueueEvents#on(completed)] job ${jobId} completed`),
  );

  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[QueueEvents#on(failed)] job ${jobId} failed: ${failedReason}`,
    ),
  );

  createJobs(queue).catch((error) =>
    console.error('[createJobs] failed to create jobs:', error),
  );

  return {
    schedulerQueue: queue,
    schedulerWorker: worker,
    schedulerQueueEvents: queueEvents,
  };
}
