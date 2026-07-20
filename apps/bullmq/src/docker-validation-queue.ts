import { Queue, QueueEvents, Worker } from 'bullmq';

import { DOCKER_VALIDATION_QUEUE_NAME } from '@roomote/types';
import type { DockerEnvironmentValidationResult } from '@roomote/compute-providers';

import { getRedis } from './redis';
import {
  type DockerValidationJobData,
  dockerValidationJob,
} from './jobs/docker-validation';

export function startDockerValidationQueue() {
  const connection = getRedis();

  const queue = new Queue<
    DockerValidationJobData,
    DockerEnvironmentValidationResult,
    string
  >(DOCKER_VALIDATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Validation is interactive and single-shot: the settings UI waits on
      // the result, so a retry would only delay an accurate failure report.
      attempts: 1,
      removeOnComplete: { age: 600, count: 50 },
      removeOnFail: { age: 3600 },
    },
  });

  const worker = new Worker<
    DockerValidationJobData,
    DockerEnvironmentValidationResult,
    string
  >(DOCKER_VALIDATION_QUEUE_NAME, dockerValidationJob, {
    connection,
    concurrency: 1,
    autorun: true,
    // Image pulls can be slow on first validation.
    lockDuration: 180_000,
  });

  worker.on('failed', (job, err) =>
    console.error(
      `[DockerValidationQueue] job ${job?.id} failed:`,
      err.message,
    ),
  );

  worker.on('error', (err) =>
    console.error('[DockerValidationQueue] worker error:', err),
  );

  const queueEvents = new QueueEvents(DOCKER_VALIDATION_QUEUE_NAME, {
    connection,
  });

  console.log('[DockerValidationQueue] Started docker validation worker');

  return {
    dockerValidationQueue: queue,
    dockerValidationWorker: worker,
    dockerValidationQueueEvents: queueEvents,
  };
}
