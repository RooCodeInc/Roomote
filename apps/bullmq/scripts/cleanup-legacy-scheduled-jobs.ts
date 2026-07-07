#!/usr/bin/env tsx

/**
 * Inspect or remove stale BullMQ schedulers and delayed jobs from the
 * scheduled-jobs queue.
 *
 * Dry run is the default.
 *
 * Usage (from repo root):
 *   pnpm --filter @roomote/bullmq exec tsx scripts/cleanup-legacy-scheduled-jobs.ts
 *   pnpm --filter @roomote/bullmq exec tsx scripts/cleanup-legacy-scheduled-jobs.ts --apply
 */

import { Queue } from 'bullmq';

import { closeRedis, getRedis } from '../src/redis';
import { ScheduledJobName } from '../src/types';

const SCHEDULED_JOBS_QUEUE_NAME = 'scheduled-jobs';
const LEGACY_SCHEDULED_JOB_NAMES = new Set<string>(['RefreshSandboxOidc']);
const APPLY_FLAG = '--apply';

function usage(): never {
  console.error(`
Usage:
  tsx scripts/cleanup-legacy-scheduled-jobs.ts [--apply]

Options:
  --apply    Remove unknown job schedulers and delayed jobs. Without this flag,
             the script performs a dry run and reports what would be removed.

Behavior:
  - Keeps only the currently supported scheduled job names:
    ${Object.values(ScheduledJobName).join(', ')}
  - Treats migrated schedulers as stale legacy entries:
    ${Array.from(LEGACY_SCHEDULED_JOB_NAMES).join(', ')}
  - Removes unknown scheduler ids from the scheduled-jobs queue
  - Removes delayed jobs whose names are not in the active set
  - Does not touch waiting, active, completed, or failed jobs
`);
  process.exit(1);
}

function parseArgs(): { apply: boolean } {
  const args = process.argv.slice(2);
  let apply = false;

  for (const arg of args) {
    if (arg === APPLY_FLAG) {
      apply = true;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  return { apply };
}

async function main() {
  const { apply } = parseArgs();
  const queue = new Queue(SCHEDULED_JOBS_QUEUE_NAME, {
    connection: getRedis(),
  });
  const activeJobNames = new Set<string>(Object.values(ScheduledJobName));

  try {
    const schedulers = await queue.getJobSchedulers();
    const delayedJobs = await queue.getJobs(['delayed']);

    const unknownSchedulers = schedulers.filter((scheduler) => {
      const schedulerId = scheduler.id ?? scheduler.name;
      return (
        LEGACY_SCHEDULED_JOB_NAMES.has(schedulerId) ||
        !activeJobNames.has(schedulerId)
      );
    });

    const unknownDelayedJobs = delayedJobs.filter(
      (job) =>
        LEGACY_SCHEDULED_JOB_NAMES.has(job.name) ||
        !activeJobNames.has(job.name),
    );

    console.log(
      `[cleanup-legacy-scheduled-jobs] mode=${apply ? 'apply' : 'dry-run'}`,
    );
    console.log(
      `[cleanup-legacy-scheduled-jobs] active job names: ${Array.from(activeJobNames).join(', ')}`,
    );

    console.log(
      `[cleanup-legacy-scheduled-jobs] unknown schedulers: ${unknownSchedulers.length}`,
    );
    for (const scheduler of unknownSchedulers) {
      console.log(
        `  - scheduler id=${scheduler.id ?? 'null'} name=${scheduler.name} key=${scheduler.key} next=${scheduler.next ?? 'null'}`,
      );
    }

    console.log(
      `[cleanup-legacy-scheduled-jobs] unknown delayed jobs: ${unknownDelayedJobs.length}`,
    );
    for (const job of unknownDelayedJobs) {
      console.log(
        `  - delayed job id=${job.id} name=${job.name} delay=${job.delay} timestamp=${job.timestamp}`,
      );
    }

    if (!apply) {
      console.log(
        `[cleanup-legacy-scheduled-jobs] dry run only; rerun with ${APPLY_FLAG} to delete the entries above.`,
      );
      return;
    }

    for (const scheduler of unknownSchedulers) {
      const schedulerId = scheduler.id ?? scheduler.name;
      const removed = await queue.removeJobScheduler(schedulerId);
      console.log(
        `  removed scheduler ${schedulerId}: ${removed ? 'yes' : 'no'}`,
      );
    }

    for (const job of unknownDelayedJobs) {
      await job.remove();
      console.log(`  removed delayed job ${job.id} (${job.name})`);
    }

    console.log('[cleanup-legacy-scheduled-jobs] cleanup complete');
  } finally {
    await queue.close();
    await closeRedis();
  }
}

main().catch((error) => {
  console.error('[cleanup-legacy-scheduled-jobs] failed:', error);
  void closeRedis().finally(() => process.exit(1));
});
