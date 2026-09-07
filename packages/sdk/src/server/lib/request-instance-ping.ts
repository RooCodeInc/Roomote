import { Queue } from 'bullmq';

import { getRedis } from '@roomote/redis';

/**
 * The bullmq scheduled-jobs queue and the job names it dispatches on
 * (apps/bullmq ScheduledJobName). Duplicated as literals because the enum
 * lives in the bullmq app, which the SDK cannot depend on.
 */
const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';
const INSTANCE_PING_JOB = 'InstancePing';
const LICENSE_USAGE_SYNC_JOB = 'LicenseUsageSync';
const BRAIN_BACKFILL_JOBS = [
  'BrainOutboxDrain',
  'BrainCollectors',
  'PullRequestAnalyticsSync',
] as const;

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(SCHEDULED_JOBS_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 3600 },
      },
    });
  }

  return queue;
}

/** Test seam: drop the memoized queue so a fresh connection is created. */
export function resetInstancePingQueueForTests(): void {
  queue = null;
}

/**
 * Requests an immediate anonymous instance report instead of waiting for the
 * daily InstancePing tick. Used after moments that change what the report
 * says — setup completion and user admission — so a fresh deployment's user
 * count reaches the Ping service within minutes rather than a day.
 *
 * Fire-and-forget: bursts collapse onto a per-minute job id, a single
 * attempt is enough (the daily schedule is the safety net), and failures are
 * swallowed because telemetry must never break signup or setup.
 */
export async function requestInstancePing(reason: string): Promise<void> {
  try {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    await getQueue().add(
      INSTANCE_PING_JOB,
      { reason },
      { jobId: `instance-ping-request-${minuteBucket}` },
    );
  } catch (error) {
    console.warn(
      `[requestInstancePing] failed to enqueue (reason=${reason}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Requests prompt delivery of durable licensed-usage observations. Unlike
 * telemetry, missed queue requests are harmless because the scheduler drains
 * the database outbox again.
 */
export async function requestLicenseUsageSync(reason: string): Promise<void> {
  try {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    await getQueue().add(
      LICENSE_USAGE_SYNC_JOB,
      { reason },
      { jobId: `license-usage-sync-request-${minuteBucket}` },
    );
  } catch (error) {
    console.warn(
      `[requestLicenseUsageSync] failed to enqueue (reason=${reason}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Kicks the Brain ingestion jobs immediately instead of waiting out their
 * schedules (the outbox drain runs every minute, but collectors and the PR
 * facts sync only every 15). Used when memory is switched on, so the initial
 * backfill — task history, PR facts, integration sources — starts right away
 * and the settings page shows content landing within moments of enabling.
 *
 * The kicked analytics sync is asked to chain a follow-up BrainCollectors
 * run: the PR-fact → Brain sync lives in the collectors job and reads the
 * table the analytics sync populates, so the concurrent one-off collectors
 * run can race it and see nothing there yet.
 *
 * Fire-and-forget with per-minute job ids, like the requests above: the
 * regular schedules are the safety net, every job is idempotent against its
 * durable checkpoints, and a failed enqueue must never break the Settings
 * mutation that asked for it.
 */
export async function requestBrainBackfill(reason: string): Promise<void> {
  try {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    await Promise.all(
      BRAIN_BACKFILL_JOBS.map((jobName) =>
        getQueue().add(
          jobName,
          jobName === 'PullRequestAnalyticsSync'
            ? { reason, chainBrainCollectors: true }
            : { reason },
          { jobId: `brain-backfill-request-${jobName}-${minuteBucket}` },
        ),
      ),
    );
  } catch (error) {
    console.warn(
      `[requestBrainBackfill] failed to enqueue (reason=${reason}):`,
      error instanceof Error ? error.message : error,
    );
  }
}
