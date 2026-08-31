import { Queue, QueueEvents } from 'bullmq';

import { getBullMqRedis, getRedis } from '@roomote/redis';
import { DOCKER_VALIDATION_QUEUE_NAME } from '@roomote/types';
import type { DockerEnvironmentValidationResult } from '@roomote/compute-providers';

/**
 * First-run pulls of the worker image can take a while; anything past this is
 * reported as a timeout rather than leaving the settings UI hanging.
 */
const VALIDATION_TIMEOUT_MS = 120_000;

interface DockerValidationRequest {
  image?: string;
}

let validationQueue: Queue<
  DockerValidationRequest,
  DockerEnvironmentValidationResult,
  string
> | null = null;
let validationQueueEvents: QueueEvents | null = null;

function getValidationQueue() {
  if (!validationQueue) {
    validationQueue = new Queue(DOCKER_VALIDATION_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 600, count: 50 },
        removeOnFail: { age: 3600 },
      },
    });
  }

  return validationQueue;
}

function getValidationQueueEvents(): QueueEvents {
  if (!validationQueueEvents) {
    validationQueueEvents = new QueueEvents(DOCKER_VALIDATION_QUEUE_NAME, {
      connection: getBullMqRedis(),
    });
  }

  return validationQueueEvents;
}

/**
 * Request a Docker environment validation from the bullmq worker (the process
 * holding the Docker socket) and wait for its result. Throws on timeout or if
 * no worker consumes the queue — callers should surface that as "validation
 * service unavailable" rather than a failed environment.
 */
export async function requestDockerEnvironmentValidation(params: {
  image?: string;
}): Promise<DockerEnvironmentValidationResult> {
  const queue = getValidationQueue();
  const queueEvents = getValidationQueueEvents();
  await queueEvents.waitUntilReady();

  const job = await queue.add('validate-docker-environment', {
    ...(params.image ? { image: params.image } : {}),
  });

  return (await job.waitUntilFinished(
    queueEvents,
    VALIDATION_TIMEOUT_MS,
  )) as DockerEnvironmentValidationResult;
}
