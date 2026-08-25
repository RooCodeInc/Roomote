import { Queue, QueueEvents, Worker, Job } from 'bullmq';

import {
  announcerJob,
  codeQualityAuditorJob,
  codeqlTriageJob,
  conflictScanJob,
  customAutomationsJob,
  dependabotTriageJob,
  managerStatsJob,
  providerUsageLimitJob,
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
  licenseUsageSyncJob,
  webhookCleanupJob,
  standbyRetentionJob,
  prReviewNotificationDispatchJob,
  brainOutboxDrainJob,
  brainCollectorsJob,
  brainMaintenanceJob,
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
  'ProviderUsageLimitCheck',
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
  provider_usage_limit: providerUsageLimitJob,
  sentry_triage: sentryTriageJob,
  dependabot_triage: dependabotTriageJob,
  codeql_triage: codeqlTriageJob,
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

  // Automation jobs tick at their minimum supported cadence and due-gate
  // themselves against automations.enabled/schedule/lastRunAt.
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
    // The runner applies the configured deployment timezone and local-Friday
    // gate. Tick continuously so UTC date boundaries cannot exclude eastern zones.
    { every: 60 * 60 * 1000 },
  );

  await queue.upsertJobScheduler(
    'provider_usage_limit' satisfies ScheduledAutomationJobName,
    { every: 15 * 60 * 1000 },
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
    'codeql_triage' satisfies ScheduledAutomationJobName,
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
    ScheduledJobName.CustomAutomations,
    { every: 60 * 1000 }, // Every minute for five-field cron precision.
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
    ScheduledJobName.LicenseUsageSync,
    { every: 15 * 60 * 1000 }, // Drain durable usage observations promptly.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.PrReviewNotificationDispatch,
    // Terminal Roomote summaries wake the durable drain immediately. This
    // minute-level repair cadence is only for delayed and recovered work.
    { every: 60 * 1000 },
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.LicenseUsageHeartbeat,
    { every: 24 * 60 * 60 * 1000 }, // Daily billing liveness observation.
  );

  // An environment-provided license has no Settings mutation to trigger an
  // activation request, so establish or renew its Cloud lease at startup.
  await queue.add(
    ScheduledJobName.LicenseUsageHeartbeat,
    { reason: 'scheduler-startup' },
    { jobId: `license-usage-startup-${Date.now()}` },
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.WebhookCleanup,
    { every: 24 * 60 * 60 * 1000 }, // Every 24 hours.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.BrainOutboxDrain,
    // Every minute; task memories should land promptly after completion, and
    // the job no-ops in one enablement read when the Brain is disabled.
    { every: 60 * 1000 },
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.BrainCollectors,
    // Integration sources (Slack, Granola, PR facts) poll external APIs, so
    // they run on a slower cadence than the internal task-memory outbox.
    { every: 15 * 60 * 1000 },
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.BrainMaintenance,
    // 07:00 UTC daily. Roomote owns the schedule; gbrain's durable worker
    // owns the built-in cycle and prevents overlapping work internally.
    { pattern: '0 7 * * *' },
  );

  const schedulers = await queue.getJobSchedulers();
  console.log('[createJobs] getJobSchedulers ->', schedulers);
}

const runJobs = async (job: ScheduledJob): Promise<void> => {
  if (job.name !== ScheduledJobName.PrReviewNotificationDispatch) {
    console.log(`[runJobs] processing job ${job.id} of type ${job.name}`);
  }

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
    case ScheduledJobName.LicenseUsageSync:
      return licenseUsageSyncJob();
    case ScheduledJobName.LicenseUsageHeartbeat:
      return licenseUsageSyncJob({ heartbeat: true });
    case ScheduledJobName.WebhookCleanup:
      return webhookCleanupJob();
    case ScheduledJobName.StandbyRetention:
      return standbyRetentionJob();
    case ScheduledJobName.PrReviewNotificationDispatch:
      return prReviewNotificationDispatchJob();
    case ScheduledJobName.BrainOutboxDrain:
      return brainOutboxDrainJob();
    case ScheduledJobName.BrainCollectors:
      return brainCollectorsJob();
    case ScheduledJobName.BrainMaintenance:
      return brainMaintenanceJob();
    case ScheduledJobName.CustomAutomations:
      await customAutomationsJob();
      return;
    default:
      throw new Error(`Unknown job type: ${job.name}`);
  }
};

export async function startScheduler() {
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

  // Scheduled jobs are part of this process's readiness contract. Starting
  // workers without them can leave durable Postgres work undiscoverable after
  // Redis recovers, so fail startup and let the process supervisor retry.
  try {
    await createJobs(queue);
  } catch (error) {
    await queue.close().catch(() => {});
    throw error;
  }

  const worker = new Worker<unknown, void, string>(QUEUE_NAME, runJobs, {
    connection,
    concurrency: 5,
    autorun: true,
  });

  worker.on('completed', (job) => {
    if (job.name !== ScheduledJobName.PrReviewNotificationDispatch) {
      console.log(
        `[Worker#on(completed)] job ${job.id} completed successfully`,
      );
    }
  });

  worker.on('failed', (job, err) =>
    console.error(`[Worker#on(failed)] job ${job?.id} failed:`, err),
  );

  worker.on('error', (err) =>
    console.error('[Worker#on(error)] error ->', err),
  );

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[QueueEvents#on(failed)] job ${jobId} failed: ${failedReason}`,
    ),
  );

  return {
    schedulerQueue: queue,
    schedulerWorker: worker,
    schedulerQueueEvents: queueEvents,
  };
}
