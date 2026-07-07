import { Queue, QueueEvents, Worker } from 'bullmq';

import { refreshSandboxOidcJob } from './scheduled-jobs/refresh-sandbox-oidc';
import { getRedis } from './redis';

const QUEUE_NAME = 'sandbox-oidc-refresh-jobs';
const REFRESH_JOB_NAME = 'RefreshSandboxOidc';

async function createJobs(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    REFRESH_JOB_NAME,
    { every: 60 * 1000 }, // Every 60 seconds.
  );

  const schedulers = await queue.getJobSchedulers();
  console.log('[SandboxOidcRefreshQueue] getJobSchedulers ->', schedulers);
}

export function startSandboxOidcRefreshQueue() {
  const connection = getRedis();

  const queue = new Queue<undefined, void, string>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600 },
    },
  });

  const worker = new Worker<undefined, void, string>(
    QUEUE_NAME,
    async (job) => {
      console.log(
        `[SandboxOidcRefreshQueue] processing job ${job.id} of type ${job.name}`,
      );
      return refreshSandboxOidcJob();
    },
    { connection, concurrency: 1, autorun: true },
  );

  worker.on('completed', (job) =>
    console.log(
      `[SandboxOidcRefreshQueue] job ${job.id} completed successfully`,
    ),
  );

  worker.on('failed', (job, err) =>
    console.error(`[SandboxOidcRefreshQueue] job ${job?.id} failed:`, err),
  );

  worker.on('error', (err) =>
    console.error('[SandboxOidcRefreshQueue] worker error:', err),
  );

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

  queueEvents.on('completed', ({ jobId }) =>
    console.log(`[SandboxOidcRefreshQueue] job ${jobId} completed`),
  );

  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[SandboxOidcRefreshQueue] job ${jobId} failed: ${failedReason}`,
    ),
  );

  createJobs(queue).catch((error) =>
    console.error('[SandboxOidcRefreshQueue] failed to create jobs:', error),
  );

  return {
    sandboxOidcRefreshQueue: queue,
    sandboxOidcRefreshWorker: worker,
    sandboxOidcRefreshQueueEvents: queueEvents,
  };
}
