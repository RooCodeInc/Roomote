import { Queue, QueueEvents, Worker, Job } from 'bullmq';

import { getRedis } from './redis';
import { ScheduledJobName } from './types';
import {
  heartbeatJob,
  sleepCheckJob,
  refreshSnapshotsJob,
  conflictScanJob,
  announcerJob,
  suggesterJob,
  managerStatsJob,
  sentryTriageJob,
  dependabotTriageJob,
  securityAuditorJob,
  codeQualityAuditorJob,
  ciFailureTriageJob,
  pullRequestAnalyticsSyncJob,
  instancePingJob,
} from './scheduled-jobs';

const QUEUE_NAME = 'scheduled-jobs';
const LEGACY_SNAPSHOT_CHECK_JOB_NAME = 'SnapshotCheck' as const;
const LEGACY_QUEUE_CONSUMER_JOB_NAME = 'QueueConsumer' as const;

interface ScheduledJobData {
  manualTrigger?: boolean;
  bullmqJobId?: string;
}

type ScheduledJobNameOrLegacy =
  | ScheduledJobName
  | typeof LEGACY_SNAPSHOT_CHECK_JOB_NAME
  | typeof LEGACY_QUEUE_CONSUMER_JOB_NAME;

type ScheduledJob = Job<
  ScheduledJobData | undefined,
  void,
  ScheduledJobNameOrLegacy
>;

async function createJobs(queue: Queue): Promise<void> {
  await queue.removeJobScheduler(ScheduledJobName.Coach);
  await queue.removeJobScheduler(LEGACY_QUEUE_CONSUMER_JOB_NAME);

  await queue.upsertJobScheduler(
    ScheduledJobName.Heartbeat,
    { every: 1 * 60 * 60 * 1000 }, // Every hour.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.SleepCheck,
    { every: 60 * 1000 }, // Every 60 seconds.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.RefreshSnapshots,
    { every: 24 * 60 * 60 * 1000 }, // Every 24 hours.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.ConflictScan,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.Announcer,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.Suggester,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.ManagerStats,
    { pattern: '0 * * * 5,6' }, // Hourly on UTC Friday/Saturday.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.SentryTriage,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.DependabotTriage,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.SecurityAuditor,
    { every: 60 * 60 * 1000 }, // Every 60 minutes.
  );

  await queue.upsertJobScheduler(
    ScheduledJobName.CodeQualityAuditor,
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

  const schedulers = await queue.getJobSchedulers();
  console.log('[createJobs] getJobSchedulers ->', schedulers);
}

const runJobs = async (job: ScheduledJob): Promise<void> => {
  console.log(`[runJobs] processing job ${job.id} of type ${job.name}`);

  const opts = job.data ?? {};
  const jobOpts = {
    ...opts,
    bullmqJobId: job.id != null ? String(job.id) : undefined,
  };

  switch (job.name) {
    case ScheduledJobName.Heartbeat:
      return heartbeatJob();
    case ScheduledJobName.SleepCheck:
      return sleepCheckJob();
    case LEGACY_SNAPSHOT_CHECK_JOB_NAME:
      return sleepCheckJob();
    case ScheduledJobName.RefreshSnapshots:
      return refreshSnapshotsJob();
    case ScheduledJobName.Coach:
      console.log(
        '[runJobs] skipping Coach job because the automation is disabled',
      );
      return;
    case ScheduledJobName.ConflictScan:
      return conflictScanJob(jobOpts);
    case ScheduledJobName.Announcer:
      return announcerJob(jobOpts);
    case ScheduledJobName.Suggester:
      return suggesterJob(jobOpts);
    case ScheduledJobName.ManagerStats:
      return managerStatsJob(jobOpts);
    case ScheduledJobName.SentryTriage:
      return sentryTriageJob(jobOpts);
    case ScheduledJobName.DependabotTriage:
      return dependabotTriageJob(jobOpts);
    case ScheduledJobName.SecurityAuditor:
      return securityAuditorJob(jobOpts);
    case ScheduledJobName.CodeQualityAuditor:
      return codeQualityAuditorJob(jobOpts);
    case ScheduledJobName.CiFailureTriage:
      // Webhook-driven automation: never registered with a scheduler, this
      // job only serves manual Run-now triggers from the Automations page.
      return ciFailureTriageJob(jobOpts);
    case ScheduledJobName.PullRequestAnalyticsSync:
      return pullRequestAnalyticsSyncJob(opts);
    case ScheduledJobName.InstancePing:
      return instancePingJob();
    case LEGACY_QUEUE_CONSUMER_JOB_NAME:
      console.log(
        '[runJobs] skipping legacy QueueConsumer job because it has been removed',
      );
      return;
    default:
      throw new Error(`Unknown job type: ${job.name}`);
  }
};

export function startScheduler() {
  const connection = getRedis();

  const queue = new Queue<ScheduledJobData | undefined, void, ScheduledJobName>(
    QUEUE_NAME,
    {
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
    },
  );

  const worker = new Worker<
    ScheduledJobData | undefined,
    void,
    ScheduledJobNameOrLegacy
  >(QUEUE_NAME, runJobs, {
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
